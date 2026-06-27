"""
world/economy.py
================
Credit economy layer for the NPMAI Agentic World.

CreditTransaction — immutable ledger entry for every credit movement
EconomyEngine     — processes the per-tick economy, rewards, charges,
                    death transfers, teaching, and macro statistics.

Author : Sonu Kumar · NPMAI ECOSYSTEM
Session: 5 (world layer)
"""

from __future__ import annotations

import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from config.constants import CREDIT_COSTS, WORLD_CONSTANTS
from data.event_logger import EventLogger
from data.event_types import WorldEventType


def _utc_now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


# ─────────────────────────────────────────────────────────────────────────────
# CreditTransaction
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CreditTransaction:
    """
    Immutable ledger record for every credit movement in the simulation.

    `from_agent` and `to_agent` can be an agent_id string, or one of the
    special sentinel values: "territory:<id>", "system", "world".
    """
    tx_id:      str
    timestamp:  int         # UTC ms
    from_agent: str         # agent_id or "territory:<id>" or "system"
    to_agent:   str         # agent_id or "territory:<id>" or "system"
    amount:     float
    reason:     str
    tick:       int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tx_id":      self.tx_id,
            "timestamp":  self.timestamp,
            "from_agent": self.from_agent,
            "to_agent":   self.to_agent,
            "amount":     round(self.amount, 6),
            "reason":     self.reason,
            "tick":       self.tick,
        }


def _make_tx(from_agent: str, to_agent: str, amount: float, reason: str, tick: int) -> CreditTransaction:
    return CreditTransaction(
        tx_id=str(uuid.uuid4()),
        timestamp=_utc_now_ms(),
        from_agent=from_agent,
        to_agent=to_agent,
        amount=round(amount, 6),
        reason=reason,
        tick=tick,
    )


# ─────────────────────────────────────────────────────────────────────────────
# EconomyEngine
# ─────────────────────────────────────────────────────────────────────────────

class EconomyEngine:
    """
    Processes all credit flows in the simulation.

    Maintains an in-memory rolling ledger (last 10 000 transactions) for
    velocity calculation. All significant movements are also logged to the
    EventLogger / Supabase.

    Thread safety: this class is designed to be called exclusively from the
    async world tick loop — no internal locking required.
    """

    def __init__(self) -> None:
        self._logger   = EventLogger.get_instance()
        self._ledger:  deque[CreditTransaction] = deque(maxlen=10_000)
        self._tick:    int = 0
        self._tx_count_this_tick: int = 0

    # ── Per-tick burn ─────────────────────────────────────────────────────────

    async def process_tick(
        self,
        agents: Dict[str, Any],
        territories: Dict[str, Any],
    ) -> None:
        """
        Deduct recurring costs from every alive agent.

        Costs charged per tick
        ----------------------
        existence_tax         : flat 0.1 (ELDER agents pay 50%)
        memory_storage_cost   : proportional to episodic node count
        tool_maintenance_cost : proportional to active tool count (tiny)

        Agents whose credits drop to 0 or below are NOT killed here —
        LifecycleManager.process_starvation_check() handles that.  We just
        record the debit and flag them.
        """
        self._tick += 1
        self._tx_count_this_tick = 0

        starvation_risk: List[str] = []

        for agent_id, agent in list(agents.items()):
            # Skip dead / non-alive agents
            status = _attr(agent, "status")
            if hasattr(status, "value"):
                status_val = status.value
            else:
                status_val = str(status)
            if status_val in ("DEAD",):
                continue

            is_elder = status_val == "ELDER"

            # ── Existence tax ─────────────────────────────────────────────────
            tax_rate = CREDIT_COSTS.get("existence_tax", 0.1)
            if is_elder:
                tax_rate *= 0.5
            self._debit(agent, tax_rate)
            self._record(agent_id, "system", tax_rate, "existence_tax", self._tick)

            # ── Memory storage cost ───────────────────────────────────────────
            try:
                episodic_size = len(_attr(agent, "memory").episodic)
            except Exception:
                episodic_size = 0
            mem_cost = episodic_size * CREDIT_COSTS.get("memory_storage_per_node", 0.001)
            if mem_cost > 0:
                self._debit(agent, mem_cost)
                self._record(agent_id, "system", mem_cost, "memory_storage", self._tick)

            # ── Tool maintenance ──────────────────────────────────────────────
            try:
                tool_count = len(_attr(agent, "active_tools") or [])
            except Exception:
                tool_count = 0
            tool_cost = tool_count * CREDIT_COSTS.get("tool_maintenance_per_tool", 0.0005)
            if tool_cost > 0:
                self._debit(agent, tool_cost)
                self._record(agent_id, "system", tool_cost, "tool_maintenance", self._tick)

            # ── Starvation flag ───────────────────────────────────────────────
            balance = _attr(agent, "credits", 0.0) or 0.0
            if balance <= 0:
                starvation_risk.append(agent_id)

        if starvation_risk:
            await self._logger.log(
                event_type=WorldEventType.ECONOMY_TICK,
                agent_id=None,
                territory_id=None,
                data={
                    "tick":               self._tick,
                    "starvation_risk":    starvation_risk,
                    "agents_processed":   len(agents),
                    "tx_this_tick":       self._tx_count_this_tick,
                },
            )

    # ── Task reward ───────────────────────────────────────────────────────────

    async def reward_task_completion(
        self,
        agent: Any,
        task_complexity: float,
        success: bool,
        territory: Optional[Any] = None,
    ) -> float:
        """
        Credit reward for task completion.

        task_complexity : 1–10 scale (estimated from task length + tools used)
        success         : True = full reward; None = partial (50%); False = 0

        Territory bonus
        ---------------
        If the territory's resource availability is low in credit_pool,
        completing tasks there earns a 20% bonus (encourages agents to work
        where it's hardest).
        """
        if not success:
            return 0.0

        base_reward = CREDIT_COSTS.get("task_reward_base", 1.0)
        complexity_multiplier = max(0.1, min(task_complexity, 10.0)) / 5.0  # 1-10 → 0.02–2.0
        reward = base_reward * complexity_multiplier

        # Territory bonus
        if territory is not None:
            avail = {}
            try:
                avail = territory.get_resource_availability()
            except Exception:
                pass
            if avail.get("credits", 1.0) < 0.3:
                reward *= 1.2

        reward = round(reward, 4)
        self._credit(agent, reward)
        agent_id = _attr(agent, "agent_id", "unknown")
        self._record("system", agent_id, reward, "task_reward", self._tick)

        await self._logger.log(
            event_type=WorldEventType.CREDITS_EARNED,
            agent_id=agent_id,
            territory_id=_attr(agent, "territory_id"),
            data={
                "amount":       reward,
                "reason":       "task_completion",
                "complexity":   round(task_complexity, 2),
                "balance_after": round(_attr(agent, "credits", 0.0), 4),
            },
        )
        return reward

    # ── Reproduction charge ───────────────────────────────────────────────────

    async def charge_reproduction(self, agent: Any, num_children: int) -> bool:
        """Deduct 5 × num_children credits. Returns False if insufficient."""
        cost_per_child = abs(CREDIT_COSTS.get("reproduce_per_child", 5.0))
        total_cost = cost_per_child * num_children
        balance = _attr(agent, "credits", 0.0) or 0.0

        if balance < total_cost:
            return False

        self._debit(agent, total_cost)
        agent_id = _attr(agent, "agent_id", "unknown")
        self._record(agent_id, "system", total_cost, f"reproduction_{num_children}_children", self._tick)

        await self._logger.log(
            event_type=WorldEventType.CREDITS_SPENT,
            agent_id=agent_id,
            territory_id=_attr(agent, "territory_id"),
            data={
                "amount":       round(total_cost, 4),
                "reason":       "reproduction",
                "num_children": num_children,
                "balance_after": round(_attr(agent, "credits", 0.0), 4),
            },
        )
        return True

    # ── Migration charge ──────────────────────────────────────────────────────

    async def charge_migration(self, agent: Any, package_size_mb: float) -> bool:
        """Cost = base + 1 credit per MB of memory package. Returns False if insufficient."""
        base     = abs(CREDIT_COSTS.get("migrate_base", 2.0))
        per_mb   = abs(CREDIT_COSTS.get("migrate_per_mb_memory", 1.0))
        total    = round(base + per_mb * package_size_mb, 4)
        balance  = _attr(agent, "credits", 0.0) or 0.0

        if balance < total:
            return False

        self._debit(agent, total)
        agent_id = _attr(agent, "agent_id", "unknown")
        self._record(agent_id, "system", total, f"migration_{package_size_mb:.2f}mb", self._tick)

        await self._logger.log(
            event_type=WorldEventType.CREDITS_SPENT,
            agent_id=agent_id,
            territory_id=_attr(agent, "territory_id"),
            data={
                "amount":          total,
                "reason":          "migration",
                "package_size_mb": round(package_size_mb, 3),
                "balance_after":   round(_attr(agent, "credits", 0.0), 4),
            },
        )
        return True

    # ── Death transfer ────────────────────────────────────────────────────────

    async def process_death_transfer(self, dead_agent: Any, territory: Any) -> float:
        """Return dead agent's remaining credits to territory credit_pool."""
        remaining = max(0.0, _attr(dead_agent, "credits", 0.0) or 0.0)
        if remaining > 0:
            # Credit the territory pool
            try:
                if hasattr(territory, "resources"):
                    territory.resources["credit_pool"] = (
                        territory.resources.get("credit_pool", 0.0) + remaining
                    )
                elif hasattr(territory, "credit_pool"):
                    territory.credit_pool += remaining
            except Exception:
                pass

            agent_id     = _attr(dead_agent, "agent_id", "unknown")
            territory_id = _attr(territory, "territory_id", "unknown")
            self._record(agent_id, f"territory:{territory_id}", remaining, "death_transfer", self._tick)

            await self._logger.log(
                event_type=WorldEventType.CREDIT_TRANSFER,
                agent_id=agent_id,
                territory_id=territory_id,
                data={
                    "amount":    round(remaining, 4),
                    "reason":    "death_transfer",
                    "direction": f"agent→territory:{territory_id}",
                },
            )
        return remaining

    # ── Teaching ──────────────────────────────────────────────────────────────

    async def process_teaching(self, teacher: Any, student: Any) -> bool:
        """
        Deducts 1 credit from teacher (effort cost),
        awards 0.5 credits to teacher immediately (partial reputation reward).
        Net cost to teacher: 0.5 credits.
        Student pays nothing — knowledge is a gift in this world.
        """
        cost   = abs(CREDIT_COSTS.get("teach", 1.0))
        reward = cost * 0.5
        balance = _attr(teacher, "credits", 0.0) or 0.0

        if balance < cost:
            return False

        self._debit(teacher, cost)
        self._credit(teacher, reward)

        teacher_id = _attr(teacher, "agent_id", "unknown")
        student_id = _attr(student, "agent_id", "unknown")
        net_cost   = round(cost - reward, 4)

        self._record(teacher_id, student_id, net_cost, "teaching", self._tick)

        await self._logger.log(
            event_type=WorldEventType.CREDITS_SPENT,
            agent_id=teacher_id,
            territory_id=_attr(teacher, "territory_id"),
            data={
                "amount":     net_cost,
                "reason":     "teaching",
                "student_id": student_id,
                "balance_after": round(_attr(teacher, "credits", 0.0), 4),
            },
        )
        return True

    # ── Macro statistics ──────────────────────────────────────────────────────

    def calculate_gini_coefficient(self, agents: Dict[str, Any]) -> float:
        """
        Standard Gini coefficient on the credit distribution across alive agents.

        Returns 0.0 (perfect equality) to 1.0 (maximum inequality).
        Returns 0.0 when < 2 alive agents.
        """
        balances = []
        for agent in agents.values():
            status = _attr(agent, "status")
            status_val = status.value if hasattr(status, "value") else str(status)
            if status_val != "DEAD":
                b = _attr(agent, "credits", 0.0) or 0.0
                balances.append(max(0.0, b))

        n = len(balances)
        if n < 2:
            return 0.0

        balances.sort()
        total = sum(balances)
        if total == 0:
            return 0.0

        # Standard Gini formula: G = (2 * Σ i*b_i) / (n * total) - (n+1)/n
        weighted_sum = sum((i + 1) * b for i, b in enumerate(balances))
        gini = (2 * weighted_sum) / (n * total) - (n + 1) / n
        return round(max(0.0, min(1.0, gini)), 4)

    def get_economic_report(
        self,
        agents: Dict[str, Any],
        territories: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Macro-economic summary for the observatory dashboard.

        Keys
        ----
        total_credits_in_system : sum of all agent balances + all territory pools
        gini_coefficient        : credit inequality measure
        richest_agent           : {agent_id, credits}
        poorest_alive_agent     : {agent_id, credits}
        average_credits         : mean balance across alive agents
        credit_velocity         : transactions per tick (rolling 100-tick window)
        starvation_risk_count   : agents with credits <= survival_threshold
        territory_pools         : {territory_id: credit_pool}
        """
        alive_balances: Dict[str, float] = {}
        starvation_risk = 0
        survival_threshold = WORLD_CONSTANTS.get("survival_threshold", 5.0)

        for agent_id, agent in agents.items():
            status = _attr(agent, "status")
            status_val = status.value if hasattr(status, "value") else str(status)
            if status_val == "DEAD":
                continue
            b = _attr(agent, "credits", 0.0) or 0.0
            alive_balances[agent_id] = b
            if b <= survival_threshold:
                starvation_risk += 1

        territory_pools: Dict[str, float] = {}
        total_territory = 0.0
        for tid, t in territories.items():
            pool = _attr(t, "credit_pool", 0.0) or 0.0
            territory_pools[str(tid)] = round(pool, 4)
            total_territory += pool

        total_agent = sum(alive_balances.values())
        total_system = round(total_agent + total_territory, 4)

        richest_id  = max(alive_balances, key=alive_balances.get) if alive_balances else None
        poorest_id  = min(alive_balances, key=alive_balances.get) if alive_balances else None
        avg_credits = round(total_agent / max(len(alive_balances), 1), 4)

        # Credit velocity: tx in the last 100 ticks / 100
        recent_tx = [tx for tx in self._ledger if tx.tick > max(0, self._tick - 100)]
        velocity = round(len(recent_tx) / 100.0, 2)

        return {
            "tick":                  self._tick,
            "total_credits_in_system": total_system,
            "total_agent_credits":   round(total_agent, 4),
            "total_territory_credits": round(total_territory, 4),
            "gini_coefficient":      self.calculate_gini_coefficient(agents),
            "richest_agent":         {"agent_id": richest_id, "credits": round(alive_balances.get(richest_id, 0), 4)} if richest_id else None,
            "poorest_alive_agent":   {"agent_id": poorest_id, "credits": round(alive_balances.get(poorest_id, 0), 4)} if poorest_id else None,
            "average_credits":       avg_credits,
            "alive_agent_count":     len(alive_balances),
            "credit_velocity":       velocity,
            "starvation_risk_count": starvation_risk,
            "territory_pools":       territory_pools,
        }

    # ── Private helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _debit(agent: Any, amount: float) -> None:
        current = _attr(agent, "credits", 0.0) or 0.0
        new_val = current - amount
        if isinstance(agent, dict):
            agent["credits"] = new_val
        else:
            agent.credits = new_val

    @staticmethod
    def _credit(agent: Any, amount: float) -> None:
        current = _attr(agent, "credits", 0.0) or 0.0
        new_val = current + amount
        if isinstance(agent, dict):
            agent["credits"] = new_val
        else:
            agent.credits = new_val

    def _record(self, from_agent: str, to_agent: str, amount: float, reason: str, tick: int) -> None:
        tx = _make_tx(from_agent, to_agent, amount, reason, tick)
        self._ledger.append(tx)
        self._tx_count_this_tick += 1
