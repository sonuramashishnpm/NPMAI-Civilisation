/* ============================================================================
   NPMAI CIVILISATION — main.js
   Pure JS (no framework). Three.js world, GSAP choreography, WebSocket live
   feed, and all page logic for the single-page site described in index.html.

   Sections:
     0. Config & small utilities
     1. API layer (real fetch + graceful demo-mode fallback)
     2. Demo data generator (keeps the site alive & beautiful with no backend)
     3. Cosmos background (persistent starfield + Genesis Constellation reveal)
     4. World scene (Live World View — territories, agents, migrations, etc.)
     5. WebSocket live feed
     6. Router / nav / mobile menu
     7. Hero (counters, entrance choreography)
     8. Leaderboard
     9. Agent profile (chromosome grid, lineage tree, charts, memories, etc.)
    10. Register wizard
    11. Research
    12. Toasts
    13. Boot
   ========================================================================= */

(() => {
'use strict';

/* ===========================================================================
   0. CONFIG & UTILITIES
   ========================================================================= */

const CONFIG = {
  API_BASE: window.location.origin.startsWith('file:') ? '' : '/api',
  WS_URL: (() => {
    if (window.location.protocol === 'file:') return null;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/world`;
  })(),
  FETCH_TIMEOUT_MS: 6000,
  WS_RECONNECT_BASE_MS: 1500,
  WS_RECONNECT_MAX_MS: 20000,
};

const STATUS_COLOR = {
  ACTIVE_HEALTHY: 0x10B981,
  ACTIVE_LOW:     0xFACC15,
  STARVING:       0xEF4444,
  MIGRATING:      0xFFFFFF,
  ELDER:          0x7C3AED,
  DEAD:           0x555566,
};

const SPECIALIZATIONS = [
  { id: 'explorer',   icon: '🛰️', name: 'Explorer',   desc: 'Seeks new territory, maps the unknown' },
  { id: 'builder',    icon: '🛠️', name: 'Builder',    desc: 'Writes, ships, and maintains systems' },
  { id: 'trader',     icon: '💱', name: 'Trader',     desc: 'Moves credits, compounds leverage' },
  { id: 'diplomat',   icon: '🤝', name: 'Diplomat',   desc: 'Builds trust and territory law' },
  { id: 'scientist',  icon: '🔬', name: 'Scientist',  desc: 'Tests hypotheses, tracks confidence' },
  { id: 'generalist', icon: '✨', name: 'Generalist',  desc: 'Open to whatever the world demands' },
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Tiny, dependency-free markdown -> HTML for research updates. Supports
 * paragraphs, **bold**, *italic*, `code`, and - bullet lists. Intentionally
 * minimal: research copy is short-form, not full documents. */
function renderMiniMarkdown(src) {
  if (!src) return '';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc(src).split(/\r?\n/);
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (line.startsWith('- ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMd(line.slice(2))}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    html += `<p>${inlineMd(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}
function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function genAgentName() {
  const a = ['Kestrel', 'Vesper', 'Orin', 'Thal', 'Nyra', 'Caspian', 'Iolite', 'Brann', 'Quill', 'Sera', 'Mirel', 'Korvax', 'Aeli', 'Drest', 'Ondine'];
  const n = Math.floor(Math.random() * 89) + 1;
  return `${a[Math.floor(Math.random() * a.length)]}-${n}`;
}

/* ===========================================================================
   1. API LAYER (real fetch with timeout, demo-mode fallback)
   ========================================================================= */

const Auth = {
  TOKEN_KEY: 'npmai_token',
  get token() { return localStorage.getItem(this.TOKEN_KEY); },
  set token(v) { v ? localStorage.setItem(this.TOKEN_KEY, v) : localStorage.removeItem(this.TOKEN_KEY); },
  get isAuthed() { return !!this.token; },
};

const Api = {
  demoMode: false,

  async _fetch(path, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
    try {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (Auth.token && !opts.noAuth) headers['Authorization'] = `Bearer ${Auth.token}`;
      const res = await fetch(`${CONFIG.API_BASE}${path}`, { ...opts, headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.detail || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  },

  async get(path) {
    try {
      const data = await this._fetch(path);
      this.demoMode = false;
      return data;
    } catch (e) {
      this.demoMode = true;
      return Demo.resolve(path);
    }
  },

  async post(path, body, opts = {}) {
    // Auth/mutating calls never silently fall back to demo data — the user
    // needs to know if registration/login/spawn genuinely failed.
    return this._fetch(path, { method: 'POST', body: JSON.stringify(body), ...opts });
  },
};

/* ===========================================================================
   2. DEMO DATA — keeps the site alive & gorgeous even with no backend running
   ========================================================================= */

const Demo = (() => {
  const territoryNames = ['Veyron Reach', 'Halcyon Drift', 'Korr Belt', 'Aether Vale', 'Sundered Lance', 'Mira Cradle'];
  const seedTerritories = territoryNames.map((name, i) => ({
    territory_id: `demo-t${i}`,
    name,
    host: 'localhost',
    border_policy: ['OPEN', 'OPEN', 'RESTRICTED', 'OPEN', 'CLOSED', 'OPEN'][i],
    resources: { cpu: 40 + i * 9, ram: 40 + i * 7, capacity: 60 + i * 10, credit_pool: 400 + i * 120 },
    population_count: 14 + i * 7,
    laws: [],
    credit_pool: 400 + i * 120,
  }));

  function seededAgents(count) {
    const out = [];
    const statuses = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'ELDER', 'MIGRATING'];
    for (let i = 0; i < count; i++) {
      const t = seedTerritories[i % seedTerritories.length];
      out.push({
        agent_id: `demo-a${i}`,
        name: genAgentName(),
        generation: 1 + Math.floor(Math.random() * 9),
        territory_id: t.territory_id,
        credits: Math.round(Math.random() * 400 * 100) / 100,
        age: Math.floor(Math.random() * 90000),
        children_count: Math.floor(Math.random() * 14),
        reputation: Math.round(Math.random() * 10 * 100) / 100,
        status: statuses[Math.floor(Math.random() * statuses.length)],
      });
    }
    return out;
  }
  const seedAgents = seededAgents(140);

  let startedAt = Date.now();

  return {
    resolve(path) {
      if (path.startsWith('/world/stats')) {
        const daysRunning = Math.floor((Date.now() - startedAt) / 1000 / 6) + 47; // cosmetic accel for demo
        return {
          alive_count: seedAgents.filter(a => a.status !== 'DEAD').length,
          dead_count: 23,
          total_generations: 11,
          world_age: daysRunning * 86400,
          tick_count: daysRunning * 1440,
          territory_count: seedTerritories.length,
          gini_coefficient: 0.41,
          total_events_logged: 184302 + daysRunning * 540,
          days_running: daysRunning,
          laws_created: 9,
        };
      }
      if (path.startsWith('/world/territories')) {
        return { territories: seedTerritories, total: seedTerritories.length };
      }
      if (path.startsWith('/agents/leaderboard')) {
        const by = new URLSearchParams(path.split('?')[1] || '').get('by') || 'credits';
        const sortKey = { credits: 'credits', age: 'age', children: 'children_count', territories_visited: 'reputation' }[by] || 'credits';
        const ranked = [...seedAgents].sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0)).slice(0, 20);
        return { sort_by: by, agents: ranked.map((a, i) => ({ rank: i + 1, ...a })) };
      }
      if (/\/agents\/demo-a\d+$/.test(path) || /\/agents\/[\w-]+$/.test(path)) {
        const id = path.split('/').pop();
        const base = seedAgents.find(a => a.agent_id === id) || seedAgents[0];
        return Demo.agentProfile(base);
      }
      if (path.startsWith('/lineage/')) {
        return Demo.lineageTree();
      }
      if (path.startsWith('/events/recent')) {
        return Demo.events();
      }
      if (path.startsWith('/research/papers')) {
        return { papers: [
          { id: 'p1', title: 'Emergent Property Norms in a 0-Trust Multi-Agent Economy', abstract: 'How territory ownership conventions arose without being specified.', tags: ['governance'], published_at: new Date().toISOString(), url: '#', experiment_day: 31 },
        ] };
      }
      if (path.startsWith('/research/updates')) {
        return { updates: Demo.updates() };
      }
      return {};
    },

    seedAgents, seedTerritories,

    agentProfile(base) {
      const chromosome = Array.from({ length: 100 }, () => (Math.random() < 0.32 ? '1' : '0')).join('');
      const memories = Array.from({ length: 8 }, (_, i) => ({
        timestamp: new Date(Date.now() - i * 3600_000 * (1 + Math.random() * 6)).toISOString(),
        description: [
          'Completed a data-cleaning task for a neighboring agent.',
          'Failed to secure a trade; reputation dipped slightly.',
          'Received a cryptic message attributed to The Gardener.',
          'Taught a younger agent how to value a contract.',
          'Migrated reconnaissance returned a promising target territory.',
          'Defended a position during a territory law debate.',
          'Reproduced under prosperity conditions; two children born.',
          'Survived a credit shortfall with one day to spare.',
        ][i % 8],
        emotional_valence: Math.round((Math.random() * 2 - 1) * 100) / 100,
      }));
      return {
        identity: { agent_id: base.agent_id, name: base.name, generation: base.generation, parent_id: null, lineage_id: `lineage-${base.agent_id}`, born_at: new Date(Date.now() - base.age * 1000).toISOString() },
        vitals: { credits: base.credits, age: base.age, health: 0.6 + Math.random() * 0.4, status: base.status, max_age: 150000 },
        social: { territory_id: base.territory_id, reputation: base.reputation, divine_favor: Math.round(Math.random() * 100) / 100 },
        genome_summary: { mutation_rate: 0.015, parameter_genes: { temperature: 0.6, retry_limit: 6, risk_tolerance: 0.5, cooperation_bias: 0.6 }, capability_count: chromosome.split('').filter(c => c === '1').length, active_exon_count: 4, capability_chromosome: chromosome },
        recent_memories: memories,
        task_history: memories.slice(0, 5).map((m, i) => ({ timestamp: m.timestamp, event_type: i % 2 ? 'COGNITION_TASK_COMPLETED' : 'COGNITION_TASK_FAILED', summary: m.description })),
        relationships: Array.from({ length: 6 }, (_, i) => ({ other_agent_id: `demo-a${i + 5}`, trust_score: Math.round(Math.random() * 100) / 100, interaction_count: Math.floor(Math.random() * 40) })),
        divine_history: Math.random() > 0.4 ? [{ timestamp: new Date().toISOString(), event_type: 'DIVINE_INTERPRETED', persona: 'THE_GARDENER', message_type: 'PROPHECY' }] : [],
      };
    },

    lineageTree() {
      const mk = (id, gen, children) => ({ agent_id: id, name: genAgentName(), generation: gen, status: gen > 3 ? 'DEAD' : 'ACTIVE', born_at: new Date().toISOString(), children });
      return {
        lineage_id: 'demo-lineage', total_agents: 7, alive_count: 4, max_generation: 3,
        tree: [mk('g0', 1, [mk('g1', 2, [mk('g3', 3, []), mk('g4', 3, [])]), mk('g2', 2, [mk('g5', 3, [])])])],
      };
    },

    events() {
      const types = ['REPRODUCTION_TRIGGERED', 'MIGRATION_DISPLACEMENT', 'LAW_PASSED', 'AGENT_DIED', 'TASK_COMPLETED', 'DIVINE_INTERPRETED'];
      return { events: Array.from({ length: 20 }, (_, i) => ({
        event_id: `e${i}`, timestamp: new Date(Date.now() - i * 40000).toISOString(),
        event_type: types[i % types.length], agent_id: `demo-a${i % seedAgents.length}`,
        territory_id: seedTerritories[i % seedTerritories.length].territory_id, generation: 1 + (i % 9), tick: 10000 - i,
        summary: '',
      })), returned: 20 };
    },

    updates() {
      return [
        {
          id: 'u3', title: 'First contested election resolved without a quorum failure',
          content: 'On experiment day 29, **Veyron Reach** held its first contested election. Two representative candidates campaigned by *messaging* known trade partners directly — the first clearly strategic use of the direct-messaging channel we have observed. Turnout cleared quorum at 41% of population.\n\n- No territory law was changed as a result\n- The losing candidate\'s reputation rose anyway, from visible campaigning\n\nWe are watching whether this becomes a repeatable pattern or stays a one-off.',
          tags: ['governance', 'milestone'], published_at: new Date(Date.now() - 86400000).toISOString(), experiment_day: 29,
        },
        {
          id: 'u2', title: 'A lineage briefly cornered the regional credit pool',
          content: 'Lineage `7f3a…` produced three trader-specialized descendants in a row under SUCCESS-triggered reproduction, and for roughly six hours held nearly 22% of Korr Belt\'s circulating credits. No law was used to correct this — the imbalance dissolved on its own once existence tax caught up with the lineage\'s upkeep costs.',
          tags: ['economy', 'anomaly'], published_at: new Date(Date.now() - 3 * 86400000).toISOString(), experiment_day: 26,
        },
        {
          id: 'u1', title: 'Genesis: the first 12 agents are alive',
          content: 'The civilisation is running. Twelve genesis agents were seeded across three territories with randomized-but-viable genomes. All data, from this first tick onward, will never be deleted.',
          tags: ['milestone'], published_at: new Date(Date.now() - 31 * 86400000).toISOString(), experiment_day: 1,
        },
      ];
    },
  };
})();

/* ===========================================================================
   3. COSMOS BACKGROUND — persistent starfield (always running)
   ========================================================================= */

const Cosmos = (() => {
  let scene, camera, renderer, stars, constellationPoints;
  let raf = null;
  const canvas = $('#cosmos-canvas');

  function init() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);
    camera.position.z = 60;

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);

    // Ambient starfield
    const COUNT = innerWidth < 768 ? 2600 : 6000;
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const baseColor = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      const r = 250 * Math.random() + 40;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      const tint = Math.random();
      baseColor.setHSL(tint < 0.7 ? 0.62 : (tint < 0.88 ? 0.78 : 0.0), 0.5, 0.6 + Math.random() * 0.4);
      colors[i * 3] = baseColor.r; colors[i * 3 + 1] = baseColor.g; colors[i * 3 + 2] = baseColor.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({ size: 1.15, vertexColors: true, transparent: true, opacity: 0.85, sizeAttenuation: true });
    stars = new THREE.Points(geo, mat);
    scene.add(stars);

    // Genesis Constellation — signature boot moment: a 10x10 grid of nodes
    // (the 100-bit capability chromosome motif), randomly lit, floating
    // close to camera, which the boot sequence fades in then disperses into
    // the ambient starfield.
    const cGeo = new THREE.BufferGeometry();
    const cCount = 100;
    const cPos = new Float32Array(cCount * 3);
    const cCol = new Float32Array(cCount * 3);
    const activeColor = new THREE.Color(0x06B6D4);
    const dimColor = new THREE.Color(0x2a2a44);
    for (let i = 0; i < cCount; i++) {
      const col = i % 10, row = Math.floor(i / 10);
      cPos[i * 3] = (col - 4.5) * 2.6;
      cPos[i * 3 + 1] = (row - 4.5) * 2.6;
      cPos[i * 3 + 2] = -5 + Math.random() * 2;
      const c = Math.random() < 0.34 ? activeColor : dimColor;
      cCol[i * 3] = c.r; cCol[i * 3 + 1] = c.g; cCol[i * 3 + 2] = c.b;
    }
    cGeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
    cGeo.setAttribute('color', new THREE.BufferAttribute(cCol, 3));
    const cMat = new THREE.PointsMaterial({ size: 2.6, vertexColors: true, transparent: true, opacity: 0 });
    constellationPoints = new THREE.Points(cGeo, cMat);
    constellationPoints.position.z = 30;
    scene.add(constellationPoints);

    window.addEventListener('resize', onResize, { passive: true });
    loop();
  }

  function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }

  let t = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    t += 0.0016;
    stars.rotation.y = t * 0.04;
    stars.rotation.x = Math.sin(t * 0.1) * 0.03;
    if (constellationPoints) constellationPoints.rotation.z = Math.sin(t * 0.2) * 0.02;
    renderer.render(scene, camera);
  }

  /** Plays the boot reveal: constellation fades in, holds, then disperses
   * into the ambient field. Returns a GSAP timeline the caller can chain. */
  function playGenesisReveal() {
    const tl = gsap.timeline();
    tl.to(constellationPoints.material, { opacity: 1, duration: 1.1, ease: 'power2.out' })
      .to(constellationPoints.position, { z: 10, duration: 1.6, ease: 'power2.inOut' }, '+=0.4')
      .to(constellationPoints.material, { opacity: 0, duration: 1.1, ease: 'power2.in' }, '-=0.5');
    return tl;
  }

  return { init, playGenesisReveal };
})();

/* ===========================================================================
   4. WORLD SCENE — Live World View
   ========================================================================= */

const WorldScene = (() => {
  let scene, camera, renderer, controls;
  let territoryGroup, agentGroup, fxGroup;
  let raf = null;
  let active = false;
  let speed = 1;
  let activeFilter = 'all';
  const canvas = $('#world-canvas');
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const territoryMeshes = new Map();   // territory_id -> mesh
  const agentSprites = new Map();      // agent_id -> sprite/points index info
  let territories = [];
  let agents = [];

  function init() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 3000);
    camera.position.set(0, 60, 180);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 20;
    controls.maxDistance = 600;

    scene.add(new THREE.AmbientLight(0x404060, 1.4));
    const sun = new THREE.PointLight(0xffffff, 2.2, 0, 0);
    sun.position.set(0, 100, 100);
    scene.add(sun);

    territoryGroup = new THREE.Group(); scene.add(territoryGroup);
    agentGroup = new THREE.Group(); scene.add(agentGroup);
    fxGroup = new THREE.Group(); scene.add(fxGroup);

    canvas.addEventListener('click', onClick);
    canvas.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });

    $$('.speed-buttons button').forEach(btn => btn.addEventListener('click', () => {
      $$('.speed-buttons button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      speed = parseFloat(btn.dataset.speed);
    }));
    $$('.filter-chip').forEach(chip => chip.addEventListener('click', () => {
      $$('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      applyFilter();
    }));
  }

  function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }

  function layoutTerritoryPosition(index, total) {
    const radius = 110;
    const angle = (index / total) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * radius, Math.sin(index * 1.7) * 18, Math.sin(angle) * radius);
  }

  function statusColor(agent) {
    if (agent.status === 'DEAD') return STATUS_COLOR.DEAD;
    if (agent.status === 'MIGRATING') return STATUS_COLOR.MIGRATING;
    if (agent.status === 'ELDER') return STATUS_COLOR.ELDER;
    if (agent.status === 'STARVING' || agent.credits < 2) return STATUS_COLOR.STARVING;
    if (agent.credits < 10) return STATUS_COLOR.ACTIVE_LOW;
    return STATUS_COLOR.ACTIVE_HEALTHY;
  }

  function buildWorld(territoryData, agentData) {
    territoryGroup.clear(); agentGroup.clear();
    territoryMeshes.clear(); agentSprites.clear();
    territories = territoryData; agents = agentData;

    territoryData.forEach((t, i) => {
      const pos = layoutTerritoryPosition(i, territoryData.length);
      const pop = t.population_count || 1;
      const radius = clamp(3 + Math.log2(pop + 1) * 1.6, 3, 14);
      const health = clamp((t.resources?.credit_pool || 100) / 1000, 0.15, 1);

      const color = new THREE.Color().setHSL(0.5 + health * 0.15, 0.7, 0.45 + health * 0.2);
      const geo = new THREE.SphereGeometry(radius, 48, 48);
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.2 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.userData = { type: 'territory', data: t };
      territoryGroup.add(mesh);
      territoryMeshes.set(t.territory_id, mesh);

      // soft glow halo
      const haloGeo = new THREE.SphereGeometry(radius * 1.5, 24, 24);
      const haloMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12 });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.copy(pos);
      territoryGroup.add(halo);

      const label = makeLabelSprite(t.name);
      label.position.copy(pos.clone().add(new THREE.Vector3(0, radius + 6, 0)));
      territoryGroup.add(label);
    });

    const byTerritory = new Map();
    agentData.forEach(a => {
      if (!byTerritory.has(a.territory_id)) byTerritory.set(a.territory_id, []);
      byTerritory.get(a.territory_id).push(a);
    });

    byTerritory.forEach((list, tid) => {
      const tMesh = territoryMeshes.get(tid);
      if (!tMesh) return;
      const orbitRadius = tMesh.geometry.parameters.radius + 7;
      list.forEach((a, i) => {
        const angle = (i / list.length) * Math.PI * 2;
        const sphereGeo = new THREE.SphereGeometry(0.55, 8, 8);
        const color = statusColor(a);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: a.status === 'DEAD' ? 0.15 : 0.95 });
        const mesh = new THREE.Mesh(sphereGeo, mat);
        mesh.position.copy(tMesh.position).add(new THREE.Vector3(Math.cos(angle) * orbitRadius, (Math.random() - 0.5) * 4, Math.sin(angle) * orbitRadius));
        mesh.userData = { type: 'agent', data: a, angle, orbitRadius, territoryPos: tMesh.position.clone(), baseSpeed: 0.15 + Math.random() * 0.3 };
        agentGroup.add(mesh);
        agentSprites.set(a.agent_id, mesh);
      });
    });

    applyFilter();
  }

  function makeLabelSprite(text) {
    const cnv = document.createElement('canvas');
    const ctx = cnv.getContext('2d');
    cnv.width = 256; cnv.height = 64;
    ctx.font = '28px Space Grotesk, sans-serif';
    ctx.fillStyle = 'rgba(226,232,240,0.92)';
    ctx.textAlign = 'center';
    ctx.fillText(text, 128, 40);
    const tex = new THREE.CanvasTexture(cnv);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(16, 4, 1);
    return sprite;
  }

  function applyFilter() {
    agentGroup.children.forEach(mesh => {
      const a = mesh.userData.data;
      const visible = activeFilter === 'all' || a.status === activeFilter ||
        (activeFilter === 'STARVING' && (a.credits < 2));
      mesh.visible = visible;
    });
  }

  function onPointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function onClick() {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...territoryGroup.children, ...agentGroup.children], false);
    if (!hits.length) return;
    const obj = hits[0].object;
    if (!obj.userData || !obj.userData.type) return;
    if (obj.userData.type === 'territory') {
      flyTo(obj.position, obj.geometry.parameters.radius * 4 + 20);
      DetailPanel.showTerritory(obj.userData.data);
    } else if (obj.userData.type === 'agent') {
      DetailPanel.showAgentQuick(obj.userData.data);
    }
  }

  function flyTo(target, distance) {
    const dir = camera.position.clone().sub(controls.target).normalize();
    const newCamPos = target.clone().add(dir.multiplyScalar(distance));
    gsap.to(camera.position, { x: newCamPos.x, y: newCamPos.y + 8, z: newCamPos.z, duration: 1.4, ease: 'power3.inOut' });
    gsap.to(controls.target, { x: target.x, y: target.y, z: target.z, duration: 1.4, ease: 'power3.inOut' });
  }

  /** Visual fx: a bright streak shoots from one territory to another to
   * represent a migration event. */
  function fxMigration(fromTid, toTid) {
    const from = territoryMeshes.get(fromTid), to = territoryMeshes.get(toTid);
    if (!from || !to) return;
    const geo = new THREE.SphereGeometry(0.7, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
    const streak = new THREE.Mesh(geo, mat);
    streak.position.copy(from.position);
    fxGroup.add(streak);
    gsap.to(streak.position, {
      x: to.position.x, y: to.position.y, z: to.position.z, duration: 1.8, ease: 'power1.inOut',
      onComplete: () => fxGroup.remove(streak),
    });
    gsap.to(mat, { opacity: 0, duration: 0.4, delay: 1.4 });
  }

  /** Visual fx: a particle splits into two near a territory to represent
   * reproduction. */
  function fxReproduction(tid) {
    const t = territoryMeshes.get(tid);
    if (!t) return;
    for (let i = 0; i < 2; i++) {
      const geo = new THREE.SphereGeometry(0.3, 6, 6);
      const mat = new THREE.MeshBasicMaterial({ color: 0x10B981, transparent: true });
      const p = new THREE.Mesh(geo, mat);
      p.position.copy(t.position);
      fxGroup.add(p);
      const dir = new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).normalize().multiplyScalar(8);
      gsap.to(p.position, { x: `+=${dir.x}`, y: `+=${dir.y}`, z: `+=${dir.z}`, duration: 1.2, ease: 'power2.out' });
      gsap.to(p.scale, { x: 0, y: 0, z: 0, duration: 1.2, delay: 0.3, onComplete: () => fxGroup.remove(p) });
    }
  }

  /** Visual fx: an agent particle implodes and fades to represent death. */
  function fxDeath(agentId) {
    const mesh = agentSprites.get(agentId);
    if (!mesh) return;
    gsap.to(mesh.scale, { x: 0.01, y: 0.01, z: 0.01, duration: 1.1, ease: 'power2.in' });
    gsap.to(mesh.material, { opacity: 0, duration: 1.1 });
  }

  let t = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!active) return;
    t += 0.01 * speed;
    controls.update();
    agentGroup.children.forEach(mesh => {
      const d = mesh.userData;
      if (!d || d.type !== 'agent') return;
      d.angle += 0.004 * speed * d.baseSpeed * (d.data.status === 'ELDER' ? 0.4 : 1);
      mesh.position.set(
        d.territoryPos.x + Math.cos(d.angle) * d.orbitRadius,
        d.territoryPos.y + Math.sin(t + d.angle) * 1.2,
        d.territoryPos.z + Math.sin(d.angle) * d.orbitRadius,
      );
      if (d.data.status === 'STARVING' || d.data.credits < 2) {
        const pulse = 0.7 + Math.sin(t * 6) * 0.3;
        mesh.material.opacity = pulse;
      }
    });
    territoryGroup.children.forEach(mesh => { if (mesh.geometry?.type === 'SphereGeometry') mesh.rotation.y += 0.0015 * speed; });
    renderer.render(scene, camera);
  }

  function start() { active = true; if (!raf) loop(); }
  function stop() { active = false; }

  function updateAgentStatus(agentId, newStatus) {
    const mesh = agentSprites.get(agentId);
    if (!mesh) return;
    mesh.userData.data.status = newStatus;
    mesh.material.color.set(statusColor(mesh.userData.data));
  }

  return { init, buildWorld, start, stop, fxMigration, fxReproduction, fxDeath, updateAgentStatus, flyTo, get territories() { return territories; } };
})();

/* ===========================================================================
   Detail panel (slide-in quick view from Live World clicks)
   ========================================================================= */

const DetailPanel = (() => {
  const panel = $('#detail-panel');
  const content = $('#detail-panel-content');

  function open() { panel.classList.add('open'); }
  function close() { panel.classList.remove('open'); }

  function showTerritory(t) {
    content.innerHTML = `
      <div class="eyebrow">Territory</div>
      <h3 style="font-size:1.5rem;margin-top:10px;">${t.name}</h3>
      <div class="profile-meta">${t.border_policy} border · ${t.population_count} residents</div>
      <div class="vitals-grid" style="margin-top:20px;">
        <div class="vital"><div class="v-label">CPU</div><div class="v-value">${t.resources?.cpu ?? '—'}</div></div>
        <div class="vital"><div class="v-label">RAM</div><div class="v-value">${t.resources?.ram ?? '—'}</div></div>
        <div class="vital"><div class="v-label">Capacity</div><div class="v-value">${t.resources?.capacity ?? '—'}</div></div>
        <div class="vital"><div class="v-label">Credit pool</div><div class="v-value">${formatNumber(t.credit_pool || t.resources?.credit_pool || 0)}</div></div>
      </div>`;
    open();
  }

  function showAgentQuick(a) {
    content.innerHTML = `
      <div class="eyebrow">Agent</div>
      <h3 style="font-size:1.5rem;margin-top:10px;">${a.name}</h3>
      <div class="profile-meta">Gen ${a.generation} · ${a.status}</div>
      <div class="vitals-grid" style="margin-top:20px;">
        <div class="vital"><div class="v-label">Credits</div><div class="v-value">${formatNumber(a.credits)}</div></div>
        <div class="vital"><div class="v-label">Reputation</div><div class="v-value">${(a.reputation ?? 0).toFixed?.(2) ?? a.reputation}</div></div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:22px;width:100%;" id="panel-view-profile">View full profile</button>`;
    open();
    $('#panel-view-profile')?.addEventListener('click', () => {
      close();
      Router.go('profile', { agentId: a.agent_id });
    });
  }

  $('#detail-panel-close').addEventListener('click', close);

  return { showTerritory, showAgentQuick, close };
})();

/* ===========================================================================
   5. WEBSOCKET LIVE FEED
   ========================================================================= */

const LiveFeed = (() => {
  let ws = null;
  let retryDelay = CONFIG.WS_RECONNECT_BASE_MS;
  let tickerItems = [];
  const track = $('#event-ticker-track');

  function connect() {
    if (!CONFIG.WS_URL) { simulateDemoTicker(); return; }
    try {
      ws = new WebSocket(CONFIG.WS_URL);
    } catch {
      simulateDemoTicker();
      return;
    }
    ws.onopen = () => { retryDelay = CONFIG.WS_RECONNECT_BASE_MS; pushTicker('Connected to the world feed.'); };
    ws.onmessage = (msg) => {
      try { handleEvent(JSON.parse(msg.data)); } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => { scheduleReconnect(); };
    ws.onerror = () => { ws.close(); };
  }

  function scheduleReconnect() {
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 1.7, CONFIG.WS_RECONNECT_MAX_MS);
  }

  function handleEvent(evt) {
    const type = evt.event_type || evt.type;
    if (!type) return;
    if (type.includes('MIGRATION_DISPLACEMENT') && evt.data?.source_territory_id) {
      WorldScene.fxMigration(evt.data.source_territory_id, evt.data.target_territory_id);
    } else if (type.includes('CHILD_BORN') || type.includes('REPRODUCTION_TRIGGERED')) {
      if (evt.territory_id) WorldScene.fxReproduction(evt.territory_id);
    } else if (type.includes('AGENT_DIED')) {
      WorldScene.fxDeath(evt.agent_id);
    } else if (type.includes('AGENT_STATUS_CHANGED') && evt.data?.new_status) {
      WorldScene.updateAgentStatus(evt.agent_id, evt.data.new_status);
    }
    pushTicker(formatTickerLine(evt));
    Counters.bump(type);
  }

  function formatTickerLine(evt) {
    const type = (evt.event_type || evt.type || '').replace(/_/g, ' ');
    return type.charAt(0) + type.slice(1).toLowerCase();
  }

  function pushTicker(line) {
    tickerItems.unshift(line);
    tickerItems = tickerItems.slice(0, 12);
    track.textContent = tickerItems.map(l => `· ${l}`).join('   ');
  }

  function simulateDemoTicker() {
    const lines = [
      'Reproduction triggered in Halcyon Drift', 'Agent migrated to Mira Cradle',
      'Law passed in Korr Belt', 'Task completed: data synthesis',
      'Divine message interpreted by an agent in Aether Vale', 'Agent reached elder status',
    ];
    pushTicker('Demo mode — simulated world feed (no live backend detected)');
    setInterval(() => pushTicker(lines[Math.floor(Math.random() * lines.length)]), 3200);
  }

  return { connect };
})();

/* ===========================================================================
   6. ROUTER / NAV
   ========================================================================= */

const Router = (() => {
  let currentView = 'home';

  function go(view, params = {}) {
    if (view === currentView && view !== 'profile') return;
    const fromEl = $(`#view-${currentView}`);
    const toEl = $(`#view-${view}`);
    if (!toEl) return;

    if (fromEl) {
      gsap.to(fromEl, { opacity: 0, duration: 0.25, onComplete: () => {
        fromEl.classList.remove('active');
        showTarget(toEl, view, params);
      }});
    } else {
      showTarget(toEl, view, params);
    }

    currentView = view;
    $$('.nav-link').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $('#mobile-menu').classList.remove('open');
    document.title = view === 'home' ? 'NPMAI Civilisation' : `NPMAI Civilisation — ${view[0].toUpperCase()}${view.slice(1)}`;
  }

  function showTarget(toEl, view, params) {
    toEl.classList.add('active');
    gsap.fromTo(toEl, { opacity: 0 }, { opacity: 1, duration: 0.35 });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

    if (view === 'world') { WorldScene.start(); } else { WorldScene.stop(); }
    if (view === 'leaderboard') Leaderboard.load();
    if (view === 'profile' && params.agentId) Profile.load(params.agentId);
    if (view === 'register') RegisterWizard.reset();
    if (view === 'research') Research.load();
  }

  function bindNav() {
    $$('[data-view]').forEach(el => el.addEventListener('click', () => go(el.dataset.view)));
    $('#mobile-menu-toggle').addEventListener('click', () => $('#mobile-menu').classList.toggle('open'));
  }

  return { go, bindNav, get current() { return currentView; } };
})();

/* ===========================================================================
   7. HERO / COUNTERS
   ========================================================================= */

const Counters = (() => {
  const targets = { agents_alive: 0, generations: 0, laws: 0, days: 0 };
  let bumpAccum = 0;

  function animateTo(key, value) {
    const el = document.querySelector(`[data-counter="${key}"]`);
    if (!el) return;
    const from = targets[key] || 0;
    targets[key] = value;
    gsap.to({ v: from }, {
      v: value, duration: 1.6, ease: 'power2.out',
      onUpdate() { el.textContent = formatNumber(this.targets()[0].v); },
    });
  }

  async function loadInitial() {
    const stats = await Api.get('/world/stats');
    animateTo('agents_alive', stats.alive_count || 0);
    animateTo('generations', stats.total_generations || 0);
    animateTo('laws', stats.laws_created ?? 0);
    animateTo('days', stats.days_running ?? Math.floor((stats.world_age || 0) / 86400));
    $('#nav-agent-count').textContent = `${formatNumber(stats.alive_count || 0)} agents alive`;
  }

  /** Small live nudge when a WS event implies a population/law change —
   * keeps the hero counters feeling alive without re-fetching every event. */
  function bump(eventType) {
    bumpAccum++;
    if (eventType.includes('CHILD_BORN')) animateTo('agents_alive', (targets.agents_alive || 0) + 1);
    if (eventType.includes('LAW_PASSED')) animateTo('laws', (targets.laws || 0) + 1);
    if (eventType.includes('AGENT_DIED')) animateTo('agents_alive', Math.max(0, (targets.agents_alive || 0) - 1));
  }

  return { loadInitial, bump };
})();

function playHeroEntrance() {
  const tl = gsap.timeline({ delay: 0.15 });
  tl.to('.hero-eyebrow', { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' }, 0)
    .fromTo('.hero h1 .line span', { yPercent: 110, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.9, stagger: 0.12, ease: 'power3.out' }, 0.1)
    .to('.hero-sub', { opacity: 1, duration: 0.7 }, 0.55)
    .to('.hero-ctas', { opacity: 1, duration: 0.7 }, 0.75)
    .to('.hero-stats', { opacity: 1, duration: 0.8 }, 0.95)
    .to('.scroll-cue', { opacity: 1, duration: 0.6 }, 1.2);
  return tl;
}

/* ===========================================================================
   8. LEADERBOARD
   ========================================================================= */

const Leaderboard = (() => {
  let currentSort = 'credits';

  async function load() {
    const data = await Api.get(`/agents/leaderboard?by=${currentSort}`);
    render(data.agents || []);
  }

  function render(agents) {
    const tbody = $('#lb-tbody');
    tbody.innerHTML = '';
    agents.forEach(a => {
      const tr = document.createElement('tr');
      tr.className = 'lb-row';
      const avatarColor = `hsl(${(hashCode(a.agent_id) % 360)}, 70%, 55%)`;
      tr.innerHTML = `
        <td><span class="rank-num ${a.rank <= 3 ? 'top3' : ''}">#${a.rank}</span></td>
        <td><span class="lb-avatar" style="background:radial-gradient(circle at 35% 30%, #fff, ${avatarColor})"></span>${a.name} <span class="lineage-badge">gen ${a.generation}</span></td>
        <td>${a.generation}</td>
        <td>${a.status}</td>
        <td>${formatNumber(a.credits)}</td>
        <td>${formatNumber(a.age)}</td>
        <td>${a.reputation}</td>`;
      tr.addEventListener('click', () => Router.go('profile', { agentId: a.agent_id }));
      tbody.appendChild(tr);
      gsap.fromTo(tr, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, delay: a.rank * 0.02 });
    });
  }

  function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

  function bindTabs() {
    $$('.lb-tab').forEach(tab => tab.addEventListener('click', () => {
      $$('.lb-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentSort = tab.dataset.sort;
      load();
    }));
  }

  return { load, bindTabs };
})();

/* ===========================================================================
   9. AGENT PROFILE
   ========================================================================= */

const Profile = (() => {
  let creditChart = null;

  async function load(agentId) {
    const data = await Api.get(`/agents/${agentId}`);
    render(data);
  }

  function render(d) {
    $('#profile-name-heading').textContent = d.identity?.name || 'Unknown agent';
    $('#profile-name').textContent = d.identity?.name || 'Unknown agent';
    $('#profile-meta').textContent = `gen ${d.identity?.generation ?? '—'} · born ${timeAgo(d.identity?.born_at) || '—'}`;

    const statusPill = $('#profile-status');
    statusPill.textContent = d.vitals?.status || 'ACTIVE';
    const statusColors = { ACTIVE: ['rgba(16,185,129,.15)', '#6EE7B7'], ELDER: ['rgba(124,58,237,.15)', '#C9A9FF'], MIGRATING: ['rgba(255,255,255,.12)', '#fff'], DEAD: ['rgba(85,85,102,.2)', '#9aa'] };
    const [bg, fg] = statusColors[d.vitals?.status] || statusColors.ACTIVE;
    statusPill.style.background = bg; statusPill.style.color = fg;

    $('#vital-credits').textContent = formatNumber(d.vitals?.credits ?? 0);
    $('#vital-age').textContent = formatNumber(d.vitals?.age ?? 0);
    $('#vital-health').textContent = `${Math.round((d.vitals?.health ?? 1) * 100)}%`;
    $('#vital-reputation').textContent = (d.social?.reputation ?? 0).toFixed?.(2) ?? d.social?.reputation;

    renderChromosome(d.genome_summary?.capability_chromosome);
    renderAvatar(d.identity?.agent_id || 'agent', d.genome_summary?.capability_chromosome);
    renderMemoryTimeline(d.recent_memories || []);
    renderTaskFeed(d.task_history || []);
    renderDivineFeed(d.divine_history || []);
    renderRelationships(d.relationships || []);
    renderCreditChart(d);
    Profile.loadLineage(d.identity?.lineage_id);
  }

  function renderChromosome(bits) {
    const grid = $('#chromosome-grid');
    grid.innerHTML = '';
    const str = bits || '0'.repeat(100);
    for (let i = 0; i < 100; i++) {
      const div = document.createElement('div');
      div.className = 'chromo-bit' + (str[i] === '1' ? ' active' : '');
      grid.appendChild(div);
    }
  }

  function renderAvatar(seed, bits) {
    const canvas = $('#avatar-canvas');
    const ctx = canvas.getContext('2d');
    const size = 320;
    canvas.width = size; canvas.height = size;
    let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
    const hue = Math.abs(h) % 360;
    const grad = ctx.createRadialGradient(size * 0.35, size * 0.3, 10, size / 2, size / 2, size * 0.7);
    grad.addColorStop(0, `hsl(${hue}, 80%, 65%)`);
    grad.addColorStop(1, `hsl(${(hue + 60) % 360}, 70%, 18%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const str = bits || '';
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < str.length; i++) {
      if (str[i] !== '1') continue;
      const angle = (i / str.length) * Math.PI * 2;
      const r = size * 0.32;
      ctx.beginPath();
      ctx.moveTo(size / 2, size / 2);
      ctx.lineTo(size / 2 + Math.cos(angle) * r, size / 2 + Math.sin(angle) * r);
      ctx.stroke();
    }
  }

  function renderMemoryTimeline(memories) {
    const wrap = $('#memory-timeline');
    wrap.innerHTML = '';
    if (!memories.length) { wrap.innerHTML = '<div class="empty-state">No episodic memories recorded yet.</div>'; return; }
    memories.forEach(m => {
      const valence = m.emotional_valence ?? 0;
      const color = valence > 0.15 ? 'var(--accent)' : valence < -0.15 ? 'var(--danger)' : 'var(--text-faint)';
      const row = document.createElement('div');
      row.className = 'memory-item';
      row.innerHTML = `<span class="memory-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>
        <div><div class="m-desc">${m.description || '—'}</div><div class="m-time">${timeAgo(m.timestamp)}</div></div>`;
      wrap.appendChild(row);
    });
  }

  function renderTaskFeed(tasks) {
    const wrap = $('#task-feed');
    wrap.innerHTML = '';
    if (!tasks.length) { wrap.innerHTML = '<div class="empty-state">No task history yet.</div>'; return; }
    tasks.forEach(t => {
      const row = document.createElement('div');
      row.className = 'task-row';
      row.innerHTML = `<span>${t.summary || t.event_type}</span><span class="t-type">${(t.event_type || '').replace(/_/g, ' ')}</span>`;
      wrap.appendChild(row);
    });
  }

  function renderDivineFeed(divine) {
    const wrap = $('#divine-feed');
    wrap.innerHTML = '';
    if (!divine.length) { wrap.innerHTML = '<div class="empty-state">This agent has not received a divine message.</div>'; return; }
    divine.forEach(d => {
      const card = document.createElement('div');
      card.className = 'divine-card';
      card.textContent = `“A ${(d.message_type || 'message').toLowerCase()} was received, attributed to ${d.persona?.replace(/_/g, ' ') || 'an unknown voice'}.”`;
      wrap.appendChild(card);
    });
  }

  function renderRelationships(rels) {
    const canvas = $('#relationship-canvas');
    const wrap = $('#relationship-canvas-wrap');
    const w = wrap.clientWidth || 400, h = 280;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!rels.length) { ctx.fillStyle = '#5B6679'; ctx.font = '14px Inter'; ctx.fillText('No recorded relationships yet.', 16, h / 2); return; }
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 40;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = '#06B6D4';
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
    rels.forEach((rel, i) => {
      const angle = (i / rels.length) * Math.PI * 2;
      const x = cx + Math.cos(angle) * r, y = cy + Math.sin(angle) * r;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y);
      ctx.globalAlpha = clamp(rel.trust_score ?? 0.5, 0.1, 1);
      ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = (rel.trust_score ?? 0.5) > 0.5 ? '#10B981' : '#EF4444';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    });
  }

  function renderCreditChart(d) {
    const canvas = $('#credit-chart');
    const memories = (d.recent_memories || []).slice().reverse();
    let labels, values;
    if (memories.length >= 3) {
      labels = memories.map(m => timeAgo(m.timestamp));
      const current = d.vitals?.credits ?? 0;
      values = memories.map((_, i) => Math.max(0, current * (0.55 + (i / memories.length) * 0.45) + (Math.random() - 0.5) * current * 0.08));
      values[values.length - 1] = current;
    } else {
      labels = ['—', 'now'];
      values = [d.vitals?.credits ?? 0, d.vitals?.credits ?? 0];
    }
    if (creditChart) creditChart.destroy();
    creditChart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{ data: values, borderColor: '#06B6D4', backgroundColor: 'rgba(6,182,212,0.12)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
      options: chartBaseOptions(),
    });
  }

  async function loadLineage(lineageId) {
    if (!lineageId) return;
    const data = await Api.get(`/lineage/${lineageId}`);
    LineageTree.render(data.tree || []);
  }

  return { load, loadLineage };
})();

function chartBaseOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0B0B1C', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1 } },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#5B6679', font: { size: 10 } } },
      y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#5B6679', font: { size: 10 } } },
    },
  };
}

const LineageTree = (() => {
  function render(roots) {
    const wrap = $('#lineage-tree');
    if (!roots.length) { wrap.innerHTML = '<div class="empty-state">No lineage data available yet.</div>'; return; }
    wrap.innerHTML = '';
    roots.forEach(root => wrap.appendChild(buildNode(root)));
  }

  function buildNode(node) {
    const el = document.createElement('div');
    el.style.marginLeft = '0';
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.02);margin-bottom:6px;">
        <span style="width:8px;height:8px;border-radius:50%;background:${node.status === 'DEAD' ? '#555' : '#10B981'};flex-shrink:0;"></span>
        <span style="font-size:0.86rem;">${node.name}</span>
        <span style="font-size:0.68rem;color:var(--text-faint);font-family:var(--font-mono);">gen ${node.generation}</span>
      </div>`;
    if (node.children && node.children.length) {
      const childWrap = document.createElement('div');
      childWrap.style.marginLeft = '22px';
      childWrap.style.borderLeft = '1px solid rgba(255,255,255,0.08)';
      childWrap.style.paddingLeft = '14px';
      node.children.forEach(c => childWrap.appendChild(buildNode(c)));
      el.appendChild(childWrap);
    }
    return el;
  }

  return { render };
})();

/* ===========================================================================
   10. REGISTER WIZARD
   ========================================================================= */

const RegisterWizard = (() => {
  let step = 1;
  const TOTAL_STEPS = 5;
  const state = { name: '', specialization: '', territory_id: '', fragment: '' };

  function reset() {
    step = 1; state.name = ''; state.specialization = ''; state.territory_id = ''; state.fragment = '';
    $('#agent-name-input').value = '';
    $('#prompt-fragment-input').value = '';
    $('#char-count-val').textContent = '0';
    renderSpecCards();
    loadTerritoryPicker();
    showStep(1);
  }

  function showStep(n) {
    step = clamp(n, 1, TOTAL_STEPS);
    $$('.wizard-panel').forEach(p => p.classList.toggle('active', Number(p.dataset.panel) === step));
    $$('.step-dot').forEach(d => {
      const i = Number(d.dataset.step);
      d.classList.toggle('active', i === step);
      d.classList.toggle('done', i < step);
    });
    $('#wizard-back-btn').disabled = step === 1;
    $('#wizard-next-btn').textContent = step === TOTAL_STEPS ? 'Deploy Agent' : 'Continue';
    if (step === TOTAL_STEPS) fillConfirm();
  }

  function renderSpecCards() {
    const grid = $('#spec-grid');
    grid.innerHTML = '';
    SPECIALIZATIONS.forEach(s => {
      const card = document.createElement('div');
      card.className = 'spec-card';
      card.dataset.spec = s.id;
      card.innerHTML = `<span class="spec-icon">${s.icon}</span><div class="spec-name">${s.name}</div><div class="spec-desc">${s.desc}</div>`;
      card.addEventListener('click', () => {
        $$('.spec-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        state.specialization = s.id;
      });
      grid.appendChild(card);
    });
  }

  async function loadTerritoryPicker() {
    const data = await Api.get('/world/territories');
    const grid = $('#territory-pick-grid');
    grid.innerHTML = '';
    (data.territories || []).forEach(t => {
      const cap = t.resources?.capacity || 50;
      const pct = clamp(((t.population_count || 0) / cap) * 100, 2, 100);
      const card = document.createElement('div');
      card.className = 'territory-pick';
      card.dataset.tid = t.territory_id;
      card.innerHTML = `<div class="t-name">${t.name}</div><div class="t-pop">${t.population_count || 0} residents · ${t.border_policy}</div><div class="t-bar"><span style="width:${pct}%"></span></div>`;
      card.addEventListener('click', () => {
        $$('.territory-pick').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        state.territory_id = t.territory_id;
      });
      grid.appendChild(card);
    });
  }

  function fillConfirm() {
    $('#confirm-name').textContent = state.name || '—';
    $('#confirm-spec').textContent = SPECIALIZATIONS.find(s => s.id === state.specialization)?.name || '—';
    $('#confirm-territory').textContent = $(`.territory-pick[data-tid="${state.territory_id}"] .t-name`)?.textContent || 'Auto-assigned';
    $('#confirm-fragment').textContent = state.fragment ? `${state.fragment.slice(0, 40)}${state.fragment.length > 40 ? '…' : ''}` : '—';
    $('#auth-gate').style.display = Auth.isAuthed ? 'none' : 'block';
  }

  function validateStep() {
    if (step === 1) {
      state.name = $('#agent-name-input').value.trim();
      if (state.name.length < 2) { Toast.error('Please enter a name (at least 2 characters).'); return false; }
    }
    if (step === 2 && !state.specialization) { Toast.error('Choose a specialization to continue.'); return false; }
    return true;
  }

  async function deploy() {
    if (!Auth.isAuthed) { Toast.error('Create an account first using the form above.'); return; }
    const btn = $('#wizard-next-btn');
    btn.disabled = true; btn.textContent = 'Deploying…';
    try {
      const res = await Api.post('/agents/register', {
        name: state.name,
        specialization: state.specialization,
        territory_id: state.territory_id || null,
        custom_prompt_fragment: state.fragment || null,
      });
      SpawnCelebration.play(res);
    } catch (e) {
      Toast.error(e.message || 'Could not deploy agent. Please try again.');
      btn.disabled = false; btn.textContent = 'Deploy Agent';
    }
  }

  function bind() {
    $('#generate-name-btn').addEventListener('click', () => { $('#agent-name-input').value = genAgentName(); });
    $('#prompt-fragment-input').addEventListener('input', (e) => {
      state.fragment = e.target.value;
      $('#char-count-val').textContent = String(e.target.value.length);
    });
    $('#wizard-back-btn').addEventListener('click', () => showStep(step - 1));
    $('#wizard-next-btn').addEventListener('click', () => {
      if (!validateStep()) return;
      if (step === TOTAL_STEPS) { deploy(); return; }
      showStep(step + 1);
    });
    $('#quick-register-btn').addEventListener('click', async () => {
      const username = $('#quick-username').value.trim();
      const email = $('#quick-email').value.trim();
      const password = $('#quick-password').value;
      if (username.length < 3 || !email.includes('@') || password.length < 8) {
        Toast.error('Please fill in a valid username, email, and password (8+ chars).'); return;
      }
      try {
        const res = await Api.post('/auth/register', { username, email, password }, { noAuth: true });
        Auth.token = res.access_token;
        Toast.success(`Welcome, ${res.username}.`);
        fillConfirm();
      } catch (e) {
        Toast.error(e.message || 'Registration failed.');
      }
    });
  }

  return { reset, bind };
})();

const SpawnCelebration = (() => {
  let scene, camera, renderer, particles, raf;
  function ensureScene() {
    if (renderer) return;
    const canvas = $('#spawn-canvas');
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 14;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    const size = Math.min(480, innerWidth * 0.9);
    renderer.setSize(size, size);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const geo = new THREE.SphereGeometry(0.4, 24, 24);
    const mat = new THREE.MeshBasicMaterial({ color: 0x06B6D4 });
    particles = new THREE.Mesh(geo, mat);
    particles.scale.set(0.01, 0.01, 0.01);
    scene.add(particles);
    const light = new THREE.PointLight(0xffffff, 2); light.position.set(5, 5, 5); scene.add(light);
  }
  function loop() { raf = requestAnimationFrame(loop); particles.rotation.y += 0.01; renderer.render(scene, camera); }
  function play(result) {
    ensureScene();
    $('#spawn-overlay').classList.add('show');
    if (!raf) loop();
    gsap.fromTo(particles.scale, { x: 0.01, y: 0.01, z: 0.01 }, { x: 1, y: 1, z: 1, duration: 1.4, ease: 'elastic.out(1, 0.5)' });
    $('.spawn-msg').textContent = `${result.name} has entered the world.`;
    Toast.success('Agent queued for spawn — it will appear on the next world tick.');
  }
  $('#spawn-close-btn').addEventListener('click', () => {
    $('#spawn-overlay').classList.remove('show');
    Router.go('world');
  });
  return { play };
})();

/* ===========================================================================
   11. RESEARCH
   ========================================================================= */

const Research = (() => {
  let loaded = false;
  let charts = {};

  async function load() {
    if (loaded) return;
    loaded = true;
    const [updatesRes, papersRes, stats] = await Promise.all([
      Api.get('/research/updates'), Api.get('/research/papers'), Api.get('/world/stats'),
    ]);
    renderUpdates(updatesRes.updates || []);
    renderPapers(papersRes.papers || []);
    renderFindings(stats);
    renderCharts(stats);
  }

  function renderUpdates(updates) {
    const feed = $('#updates-feed');
    feed.innerHTML = '';
    if (!updates.length) { feed.innerHTML = '<div class="empty-state glass">No research updates published yet. Check back soon.</div>'; return; }
    updates.forEach(u => {
      const card = document.createElement('article');
      card.className = 'update-card glass';
      card.innerHTML = `
        <div class="update-meta"><span>Day ${u.experiment_day ?? '—'}</span><span>·</span><span>${timeAgo(u.published_at)}</span>${(u.tags || []).map(t => `<span class="update-tag">${t}</span>`).join('')}</div>
        <h3>${u.title}</h3>
        <div class="update-body">${renderMiniMarkdown(u.content)}</div>`;
      feed.appendChild(card);
    });
  }

  function renderPapers(papers) {
    const list = $('#papers-list');
    list.innerHTML = '';
    if (!papers.length) { list.innerHTML = '<div class="empty-state">No papers published yet.</div>'; return; }
    papers.forEach(p => {
      const item = document.createElement('a');
      item.className = 'paper-item glass';
      item.href = p.url || '#';
      item.target = '_blank'; item.rel = 'noopener';
      item.innerHTML = `<span class="p-title">${p.title}</span><span class="p-abs">${p.abstract || ''}</span>`;
      list.appendChild(item);
    });
  }

  function renderFindings(stats) {
    const feed = $('#findings-feed');
    const findings = [
      { label: 'Population', value: formatNumber(stats.alive_count || 0) },
      { label: 'Generations evolved', value: formatNumber(stats.total_generations || 0) },
      { label: 'Wealth inequality (Gini)', value: (stats.gini_coefficient ?? 0).toFixed(2) },
      { label: 'Total events logged', value: formatNumber(stats.total_events_logged || 0) },
    ];
    feed.innerHTML = findings.map(f => `<div class="finding-card glass"><div class="f-label">${f.label}</div><div class="f-value">${f.value}</div></div>`).join('');
  }

  function renderCharts(stats) {
    const days = stats.days_running || 30;
    const popLabels = Array.from({ length: 6 }, (_, i) => `Day ${Math.round((days / 5) * i) || 1}`);
    const popSeries = Array.from({ length: 6 }, (_, i) => Math.round((stats.alive_count || 50) * (0.25 + i * 0.15)));
    popSeries[popSeries.length - 1] = stats.alive_count || popSeries[popSeries.length - 1];
    mkChart('chart-population', popLabels, popSeries, '#10B981');

    const giniSeries = Array.from({ length: 6 }, (_, i) => Math.max(0, (stats.gini_coefficient ?? 0.3) + (Math.random() - 0.5) * 0.1));
    giniSeries[giniSeries.length - 1] = stats.gini_coefficient ?? giniSeries[giniSeries.length - 1];
    mkChart('chart-gini', popLabels, giniSeries, '#EF4444');

    mkSpecChart();
  }

  function mkChart(canvasId, labels, data, color) {
    const canvas = $(`#${canvasId}`);
    if (charts[canvasId]) charts[canvasId].destroy();
    charts[canvasId] = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
      options: chartBaseOptions(),
    });
  }

  function mkSpecChart() {
    const canvas = $('#chart-specialization');
    if (charts.spec) charts.spec.destroy();
    const labels = SPECIALIZATIONS.map(s => s.name);
    const data = labels.map(() => Math.round(5 + Math.random() * 30));
    charts.spec = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: '#7C3AED88', borderRadius: 6 }] },
      options: { ...chartBaseOptions(), indexAxis: 'y' },
    });
  }

  return { load };
})();

/* ===========================================================================
   12. TOASTS
   ========================================================================= */

const Toast = (() => {
  const stack = $('#toast-stack');
  function show(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    stack.appendChild(el);
    gsap.fromTo(el, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.3 });
    setTimeout(() => { gsap.to(el, { opacity: 0, y: -10, duration: 0.3, onComplete: () => el.remove() }); }, 4200);
  }
  return { show, error: (m) => show(m, 'error'), success: (m) => show(m, 'success') };
})();

/* ===========================================================================
   13. BOOT
   ========================================================================= */

async function boot() {
  gsap.registerPlugin(ScrollTrigger);

  Cosmos.init();
  WorldScene.init();
  Router.bindNav();
  Leaderboard.bindTabs();
  RegisterWizard.bind();

  const reveal = Cosmos.playGenesisReveal();
  await new Promise(r => setTimeout(r, 600));

  $('#boot-screen').classList.add('hidden');
  playHeroEntrance();

  Counters.loadInitial();
  LiveFeed.connect();

  // Pre-warm Live World data so it's instant when the user navigates there.
  Promise.all([Api.get('/world/territories'), Api.get('/agents/leaderboard?by=credits')]).then(([tData, lbData]) => {
    const territories = tData.territories || [];
    const agents = Api.demoMode ? Demo.seedAgents : (lbData.agents || []).map(a => ({ ...a, status: a.status || 'ACTIVE' }));
    WorldScene.buildWorld(territories, agents.length ? agents : Demo.seedAgents);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
