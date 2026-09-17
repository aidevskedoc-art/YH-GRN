export const meta = {
  name: 'nside-style-redesign',
  description: 'Recreate the NSIDE Webflow template look and motion across light/dark themes and the login: competing interpretations, judged, merged, verified',
  phases: [
    { title: 'Design', detail: '3 designers, each an interpretation of the NSIDE reference across light, dark and login' },
    { title: 'Judge', detail: '3 judges score theme, reference fidelity and login' },
    { title: 'Implement', detail: 'merge the winners into the real code' },
    { title: 'Verify', detail: 'independent visual/motion QA and code review' },
    { title: 'Fix', detail: 'apply verified fixes, re-check' },
  ],
}

const S = 'C:/Users/MR9396/AppData/Local/Temp/claude/d--koti-YH-GRN/71f308b5-fb51-4df9-9113-79bd1141685c/scratchpad'
const SB = '/c/Users/MR9396/AppData/Local/Temp/claude/d--koti-YH-GRN/71f308b5-fb51-4df9-9113-79bd1141685c/scratchpad'
const HARNESS_URL = `file:///${S}/harness/index.html`

const CONTEXT = `
PROJECT: a React + Vite finance web app for Yashoda Hospitals ("GRN Reconciliation": matches the month's GRN report against the vendor ageing report to show which goods-received notes have not reached accounts; also CSD hand-overs, an Accounts department view, a BPAD register and bank statements). Repo root D:/koti/YH-GRN, client in D:/koti/YH-GRN/client.
All styling is ONE plain-CSS file: D:/koti/YH-GRN/client/src/styles.css (~2,900 lines, no preprocessor, no Tailwind). No colours are hard-coded in JSX.
Themes: <html data-theme="dark|light">. Dark palette tokens live on bare :root; light palette overrides live in a [data-theme="light"] { ... } block near the top, plus a handful of [data-theme="light"] component rules scattered through the file. Components consume tokens (--bg, --surface, --surface-2, --surface-3, --border, --border-strong, --text, --text-2, --muted, --placeholder, --brand*, --accent, --grad-*, --ok/--warn/--danger/--info and their -soft/-line, --table-bg/-alt/-hover/--table-head-bg (MUST stay opaque colours: pinned table columns paint them over sliding rows; --table-bg-hover is --brand-50 composited over --table-bg), --shadow-1/2/3, --glow-brand, --face (panel sheen gradient), --lip, --aurora-1/2/3, --grid-dot, --rail-* (sidebar), --topbar-bg).
Current background: html paints --bg; body::before is a fixed, oversized aurora (3 radial gradients drifting); body::after is a static dot grid. Page entrance animations exist (rise/stagger) in the Motion section. The theme toggle already does a circular view-transition reveal (theme.js) — keep it.
The brand orange is #f58633 and must remain the app's accent. The app must work OFFLINE on a hospital network: no web fonts, no CDN, no external images (small inline data: URI SVGs are fine). The only raster brand asset is the hospital mark (orange flower, transparent PNG) rendered via <LogoMark size={n} /> from components/Brand.jsx.

THE LOGIN PAGE TODAY: D:/koti/YH-GRN/client/src/pages/Login.jsx. Two columns: left "aside" = a CSS-3D glass cube floating over a plinth whose front face says "Yashoda Hospitals", then a headline "Know where every bill is stuck." and a paragraph; right = .login__panel form (mark, "GRN Reconciliation", "Yashoda Healthcare Services", Username, Password, error alert, Sign in button). Below 900px the aside is hidden. D:/koti/YH-GRN/client/src/pages/NoAccess.jsx reuses .login + .login__panel (+ .noaccess, .login__title, .login__subtitle, BrandLockup) for the "No screens yet" page and must keep looking right.

THE USER'S REQUESTS (verbatim, in order):
  1. "light theme is not looking good needs more buetiful and add littile animations for the bg"
  2. "login screen is not looking good modify it.."
  3. "use some grediants and annimations for on themes so that those looks butifully and proffessionally."
  4. "https://webflow.com/made-in-webflow/website/nside-or-cloneable-cms-template  this annimation and light theme is cool implement like that"
Request 4 is the decisive direction: recreate the NSIDE template's light theme and animation language in this app, adapted to a data-heavy finance tool, in BOTH themes, including the login. Requests 1-3 still apply (beautiful light theme, background motion, tasteful gradients) but must serve the NSIDE look, not compete with it.

THE REFERENCE SPEC — READ IT FIRST, AND VIEW ITS REFERENCE FRAMES:  ${S}/ref/NSIDE-SPEC.md
It contains the exact palette, type, grid/pin-stripe structure, the full motion catalogue with durations and easing curves measured from the live site, and the "Adapting it" rules.

RENDER HARNESS (how every design is judged):
  ${S}/harness/index.html loads the real repo styles.css, then optionally ../candidates/<css>/override.css AND ../candidates/<css>/login.js.
  Query: t=light|dark, page=results|upload|login|noaccess, sheet=1 (dialog open over results), error=1 (sign-in error alert on login), css=<candidate-folder-name>, still=1 (fast-forwards all animations by 30s: finite animations finished, infinite ones running; use for static comparison shots).
  login.js may define (read the harness source to see exactly how they are used):
     window.CANDIDATE_LOGIN = function (h) { return '<div class="login">...</div>'; }   replaces the login markup; h = { MARK, ico, I, theme, error }
     window.CANDIDATE_BODY_START = '<div ...>...</div>'   inserted before #root on EVERY page (e.g. the curtain preloader, a pin-stripe layer) — the app would mount this once from main.jsx
     window.CANDIDATE_INIT = function (h) { ... }   runs after the markup exists (prototype a small behaviour the app would implement as a React hook, e.g. magnetic buttons); h = { page, theme }
     Markup must translate 1:1 into JSX (no inline event handlers, no inline style colours).
  The harness body also contains, before #root: <div class="app-backdrop" aria-hidden="true"> + 12 empty <span>s, which a design may style or ignore.
  STATIC screenshot (Git Bash):  bash ${SB}/harness/shoot.sh "<query incl. still=1>" <out.png> [width=1440] [height=900] [ms=2500]
  REAL-TIME motion frames (Git Bash):  node ${SB}/ref/capture.mjs "${HARNESS_URL}?<query WITHOUT still>" <outDir> 1440 900 load "100,300,600,900,1300,1800,2600"
     This drives Chrome over DevTools and saves load-00100.png ... — use it to watch preloader curtains, masked text reveals and staggers actually play. Run captures one or two at a time (each starts its own Chrome).
  View any PNG with the Read tool (Windows path C:/Users/...). LOOK at your images critically; do not guess.
  Baselines (current app): ${S}/baseline/light-results.png, light-upload.png, light-login.png, light-sheet.png, light-noaccess.png, dark-results.png, dark-upload.png, dark-login.png.
  Harness scope: Results, Upload, a dialog, Login, No-access. Other screens (CSD, Accounts, Users, Logs, Config, Uploaded files) reuse the same components (.page__head, .card, .stat, .table, .pill, .toolbar, .sheet, buttons, fields, .spans, .choice, .tag), so style components, not pages.

HARD CONSTRAINTS:
- Performance: animate transform and opacity (clip-path acceptable for small/one-off reveals). No animated filter/blur or box-shadow on large areas, no layout-affecting animations (width/height) on big elements — emulate NSIDE's size wipes with transform: scaleX/scaleY or clip-path. Background layers position:fixed, pointer-events:none, behind content, never creating a containing block/stacking problem (no transform/filter on html/body/#root/.app-shell).
- Readability: dense numeric tables. After an entrance finishes, nothing that contains text keeps a skew/transform; nothing moves behind table text; WCAG AA contrast (4.5:1 body, 3:1 large text/UI). Status pills (pending/valid/received/rejected/queued/approved/moved_to_accounts) stay legible and distinguishable.
- Sticky tables: never leave a transform, filter or will-change on .table-wrap or any ancestor inside .page except during a finite entrance animation using fill-mode backwards (a 'both'/'forwards' fill that holds a transform counts as left on). Animations holding transform also silently beat :hover transforms on the same element.
- Everyday motion budget: route-change reveals roughly 600-900ms total with the reference's easings and 60-200ms staggers; hovers 300-600ms. The curtain preloader: once per browser session on first app/login load only, never on route change, pointer-events:none so it never blocks input, total under ~2.2s, skipped entirely under prefers-reduced-motion.
- prefers-reduced-motion: every new animation explicitly off (animation: none / transition: none as appropriate) in the reduce media query; the preloader not rendered/visible at all.
- App screens: do not change layout geometry of existing app components (widths, paddings, grid templates, sticky/pinned positioning, chrome z-indexes) beyond small visual adjustments (radii, border widths, letter-spacing, font weight/size of labels and headings within reason). The pin-stripe grid is a decorative background layer, not a new layout grid.
- LOGIN: layout MAY be redesigned completely. Keep labelled Username and Password inputs (autocomplete username/current-password, username autofocus, both required), the error alert slot, a primary submit button (disabled + "Signing in..." while submitting), the hospital mark, "GRN Reconciliation" and the Yashoda name. Copy may be rewritten but must be truthful about what this internal tool does: no invented statistics, customer counts, testimonials, certifications or security claims. No dead controls (no nav links, "Forgot password", "Schedule a call", SSO buttons that go nowhere). Decorative parts aria-hidden. Must work at phone width (~420px) and at 1280-1920.
- JS: only small, well-contained React pieces are acceptable (e.g. a Preloader component that remembers it played this session via sessionStorage in try/catch; an optional magnetic-hover hook with cleanup). No libraries.
- Keep existing selectors used by other screens; you may add new ones.
`

const DIRECTIONS = [
  {
    key: 'cand-a',
    title: 'Faithful NSIDE',
    brief: `Reproduce the reference as closely as a finance tool allows. LIGHT: white page, #f3f6fc pin-stripe vertical lines in the background, hairline #e2e7f1 cell structure, ink #090b19 headings with tight negative tracking, slate body, tracked uppercase labels for crumbs/captions/table headers/stat labels, square-ish cells, lavender icon circles, ink filled pill buttons (brand orange reserved for the primary action and key accents), no shadows beyond the faintest. Motion: the curtain preloader, masked+skewed heading reveals, card rise+unskew staggers, the expanding-circle card hover, list/nav hover shifts. DARK: the same, "NSIDE at night" on the existing deep ink. LOGIN: the NSIDE hero reproduced — curtain reveal, huge masked headline, pin stripes over a CSS-built hero panel standing in for the photo, tracked label, outline circle, and the sign-in form as the white anchored card.`,
  },
  {
    key: 'cand-b',
    title: 'NSIDE x Yashoda warmth',
    brief: `NSIDE's structure, typography and motion, warmed for the brand. The brand orange takes over the role NSIDE gives to ink for actions and active states; the lavender pin tint is re-tuned to a neutral that sits well with orange; restrained gradients appear where NSIDE has photography (login hero panel: deep ink with a soft orange light and architectural line work; a subtle warm light on the active stat card). LIGHT stays white and airy; DARK is warm-lit ink. Motion follows the reference catalogue, shortened for everyday screens. LOGIN: split editorial hero with the masked headline reveal and a gradient-lit visual panel, the form as a clean white/ink card.`,
  },
  {
    key: 'cand-c',
    title: 'NSIDE motion-forward',
    brief: `Faithful NSIDE palette and structure, but the richest professional adaptation of its INTERACTIONS: curtain preloader; masked+skewed reveals for the top-bar title, page lead and section captions on every route; card rise+unskew with staggers; the expanding #f3f6fc circle flooding stat cards on hover with the value nudging up; nav items with the NSIDE pill-outline hover; list/table row hover shifting text with an arrow easing in where rows are links/actions; icon buttons scaling 1.15; magnetic pull on the primary button and the theme toggle (prototype in CANDIDATE_INIT); cover-wipe reveal (clip-path/scale) on panels as they enter. Everything must still pass the everyday motion budget and the sticky-table rules. LOGIN: the full NSIDE hero choreography.`,
  },
]

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    concept: { type: 'string', description: 'The app-screen theme system in light AND dark, and how it maps the NSIDE reference' },
    loginConcept: { type: 'string', description: 'The login redesign, both themes' },
    motion: { type: 'string', description: 'Every animation you added: trigger, duration, easing, stagger, and which reference item it adapts' },
    jsNeeded: { type: 'string', description: 'Any React pieces the app would need (preloader, hooks), or "none"' },
    overrideCss: { type: 'string', description: 'Absolute path of override.css' },
    loginJs: { type: 'string', description: 'Absolute path of login.js, or empty' },
    usesBackdropSpans: { type: 'boolean' },
    screenshots: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, path: { type: 'string' } }, required: ['label', 'path'] } },
    contrastNotes: { type: 'string' },
    weaknesses: { type: 'string', description: 'Honest remaining weaknesses' },
  },
  required: ['name', 'concept', 'loginConcept', 'motion', 'jsNeeded', 'overrideCss', 'loginJs', 'usesBackdropSpans', 'screenshots', 'weaknesses'],
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidate: { type: 'string', description: 'exact candidate name as given' },
          themeScore: { type: 'number', description: '1-10: app screens in light AND dark as one system, including motion' },
          fidelityScore: { type: 'number', description: '1-10: how convincingly it delivers the NSIDE look and animation the user asked for' },
          loginScore: { type: 'number', description: '1-10: login page, both themes, including its motion' },
          strengths: { type: 'string' },
          weaknesses: { type: 'string' },
        },
        required: ['candidate', 'themeScore', 'fidelityScore', 'loginScore', 'strengths', 'weaknesses'],
      },
    },
    themeWinner: { type: 'string' },
    loginWinner: { type: 'string' },
    graftIdeas: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, idea: { type: 'string' } }, required: ['from', 'idea'] } },
    mustAvoid: { type: 'array', items: { type: 'string' } },
  },
  required: ['lens', 'scores', 'themeWinner', 'loginWinner', 'graftIdeas'],
}

const ISSUES_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          area: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string', description: 'file:line, screenshot path, or measured value' },
          suggestedFix: { type: 'string' },
        },
        required: ['severity', 'area', 'description', 'evidence', 'suggestedFix'],
      },
    },
    screenshots: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
  required: ['issues', 'verdict'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    buildOk: { type: 'boolean' },
    screenshots: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, path: { type: 'string' } }, required: ['label', 'path'] } },
    notes: { type: 'string' },
  },
  required: ['summary', 'filesChanged', 'buildOk', 'screenshots'],
}

// ---------------------------------------------------------------- Design
phase('Design')
const designs = (await parallel(DIRECTIONS.map(d => () => agent(`${CONTEXT}

YOU ARE DESIGNER "${d.key}". Interpretation: "${d.title}".
${d.brief}

Your job: an NSIDE-style theme system for the app screens in LIGHT and DARK, with its motion, plus a redesigned LOGIN in both themes.

Rules for you specifically:
- Write ONLY inside ${S}/candidates/${d.key}/ . Stylesheet: ${S}/candidates/${d.key}/override.css (loads after the repo's styles.css). Markup/behaviour hooks: ${S}/candidates/${d.key}/login.js. DO NOT edit any file under D:/koti/YH-GRN. No git commands that change anything.
- First: read ${S}/ref/NSIDE-SPEC.md and VIEW every reference frame it lists; then read the token blocks, Base, shell (.sidebar/.topbar), .card/.stat/.table/.drop/.sheet__panel, "Three-dimensional pieces", "Login" and Motion sections of D:/koti/YH-GRN/client/src/styles.css, pages/Login.jsx, pages/NoAccess.jsx and ${S}/harness/index.html; view the baselines.
- Tokens for both themes (:root = dark, [data-theme="light"] = light) plus component rules. Dark must remain a deep-ink skin with the orange accent and be at least as readable as its baseline.
- Hover/focus states can't be seen statically: check them by temporarily copying the :hover rules onto static selectors (e.g. .stat:nth-child(2), .nav-item:nth-child(4)) in a scratch copy of your override, shooting, then removing the scratch rules.
- Iterate at least 3 render -> look -> refine rounds, viewing images each round. Final round, save and view:
   static (still=1): light AND dark for results, upload, results sheet=1, noaccess, login, login error=1; width 420 for results and login in both themes; light login at 1920x1080.
   real-time (capture.mjs): light login, dark login, light results — so the preloader, masked reveals and staggers can be judged. Name the output folders motion-<theme>-<page>.
- Be self-critical about: does it genuinely feel like NSIDE (the user's explicit ask), is it still a comfortable all-day finance tool, legibility of tables/pills/fields, whether light and dark feel like one product, whether the login is a premium entrance, and anything cheap, templated or gimmicky.

Return the structured result (list the real-time frame folders among screenshots, one entry per folder, path = the folder).`, { label: `design:${d.key}`, phase: 'Design', schema: DESIGN_SCHEMA })))).filter(Boolean)

log(`${designs.length}/${DIRECTIONS.length} designs completed: ${designs.map(x => x.name).join(', ')}`)
if (designs.length === 0) return { error: 'no designs produced' }

const designDigest = designs.map(x => `### ${x.name}
override.css: ${x.overrideCss}
login.js: ${x.loginJs || '(none)'}
uses .app-backdrop spans: ${x.usesBackdropSpans}
theme concept: ${x.concept}
login concept: ${x.loginConcept}
motion: ${x.motion}
JS needed: ${x.jsNeeded}
contrast notes: ${x.contrastNotes || '-'}
self-reported weaknesses: ${x.weaknesses}
screenshots / frame folders:
${x.screenshots.map(s => `  - ${s.label}: ${s.path}`).join('\n')}`).join('\n\n')

// ---------------------------------------------------------------- Judge
phase('Judge')
const LENSES = [
  { key: 'reference', text: 'REFERENCE FIDELITY AND BEAUTY: the user explicitly asked for the NSIDE template\'s light theme and animation. Compare every candidate against the reference frames in the spec. Which one would make the user say "yes, like that"? Judge palette, whitespace, pin stripes, hairline cells, tracked labels, tight headings, and above all the motion choreography in the real-time frame folders (curtain, masked skew reveals, staggers). Also judge overall polish and whether dark and login carry the same language.' },
  { key: 'usability', text: 'DAILY USABILITY OF A FINANCE TOOL: legibility of tables, numbers, pills and form fields in both themes; estimate contrast on the actual ground; is any motion slow, repetitive or distracting for people switching screens all day; does the preloader stay out of the way; phone-width and 1920 layouts; dialog, upload drop zones, error states, no-access page; truthful login copy with no dead controls. Penalise anything pretty but tiring or hard to read.' },
  { key: 'engineering', text: 'ENGINEERING QUALITY AND RISK: read each override.css and login.js. Transform/opacity/clip-path only; no size animations on big elements; no lingering transforms on sticky-table ancestors; fill-modes that would beat :hover; reduced motion fully handled incl. preloader; background layers fixed + pointer-events:none; opaque table tokens preserved; specificity sane, no !important abuse, no layout geometry changes; offline-safe; how cleanly the markup/hooks translate into JSX and small React pieces (preloader once per session via sessionStorage try/catch, hook cleanup) and merge into styles.css.' },
]
const judgements = (await parallel(LENSES.map(l => () => agent(`${CONTEXT}

YOU ARE A JUDGE. Lens: ${l.text}

Read ${S}/ref/NSIDE-SPEC.md and view its reference frames first. Then view EVERY listed screenshot and frame folder of every candidate (and the baselines), and read each override.css and login.js. You may take extra harness shots or captures of any candidate (write under ${S}/judges/${l.key}/).

${designDigest}

Score every candidate through your lens only: themeScore (app screens, light+dark, incl. motion), fidelityScore (NSIDE look and animation), loginScore. Use the exact candidate names. Name a theme winner and a login winner (may differ), list concrete graft ideas from other candidates (which rule/effect/markup), and list things the implementation must avoid.`, { label: `judge:${l.key}`, phase: 'Judge', schema: JUDGE_SCHEMA })))).filter(Boolean)

function tallyBy(fields) {
  const t = {}
  for (const j of judgements) for (const s of j.scores) t[s.candidate] = (t[s.candidate] || 0) + fields.reduce((a, f) => a + (s[f] || 0), 0)
  return Object.entries(t).sort((a, b) => b[1] - a[1])
}
function findDesign(name) {
  const n = String(name || '').toLowerCase()
  return designs.find(x => x.name.toLowerCase() === n)
    || designs.find(x => n.includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(n))
    || designs.find(x => x.overrideCss.toLowerCase().includes(n))
    || designs[0]
}
const themeRank = tallyBy(['themeScore', 'fidelityScore'])
const loginRank = tallyBy(['loginScore', 'fidelityScore'])
log(`Theme (+fidelity) totals: ${themeRank.map(([k, v]) => `${k}=${v}`).join(', ')}`)
log(`Login (+fidelity) totals: ${loginRank.map(([k, v]) => `${k}=${v}`).join(', ')}`)
const themeWinner = findDesign(themeRank.length ? themeRank[0][0] : designs[0].name)
const loginWinner = findDesign(loginRank.length ? loginRank[0][0] : designs[0].name)

const judgeDigest = judgements.map(j => `### Judge (${j.lens}) theme winner: ${j.themeWinner} | login winner: ${j.loginWinner}
${j.scores.map(s => `- ${s.candidate}: theme ${s.themeScore}/10, fidelity ${s.fidelityScore}/10, login ${s.loginScore}/10. + ${s.strengths} | - ${s.weaknesses}`).join('\n')}
Graft ideas:
${j.graftIdeas.map(g => `- from ${g.from}: ${g.idea}`).join('\n')}
Must avoid:
${(j.mustAvoid || []).map(m => `- ${m}`).join('\n')}`).join('\n\n')

// ---------------------------------------------------------------- Implement
phase('Implement')
const impl = await agent(`${CONTEXT}

YOU ARE THE IMPLEMENTER.
Theme winner (light + dark app screens and motion): "${themeWinner.name}" (override: ${themeWinner.overrideCss}; login.js: ${themeWinner.loginJs || '(none)'}; uses .app-backdrop spans: ${themeWinner.usesBackdropSpans})
Login winner: "${loginWinner.name}" (override: ${loginWinner.overrideCss}; login.js: ${loginWinner.loginJs || '(none)'})
Theme totals: ${themeRank.map(([k, v]) => `${k}=${v}`).join(', ')}
Login totals: ${loginRank.map(([k, v]) => `${k}=${v}`).join(', ')}

All candidates:
${designDigest}

Judge reports:
${judgeDigest}

TASK: merge the winning theme system and the winning login, plus graft ideas that clearly improve them, into the REAL codebase, resolving every 'must avoid'. The result must read as the NSIDE look and motion the user asked for. If the two winners differ, unify them into one visual language. Then verify visually and in motion.

How:
1. Edit D:/koti/YH-GRN/client/src/styles.css directly. Dark tokens in :root, light tokens in [data-theme="light"]; component rules on the component's own rule, light-only rules beside their base rule; background/pin-stripe layer in the Base section (replace the aurora/dot grid if the design replaces them); login styles replace the "Login" section (delete the "Three-dimensional pieces" section and its keyframes if the cube scene is gone — check nothing else uses them); keyframes in the Motion section; every new animation switched off in the existing prefers-reduced-motion block. Remove CSS the new design makes dead. No bolted-on override block at the end of the file.
2. Rewrite D:/koti/YH-GRN/client/src/pages/Login.jsx to the winning markup as JSX, keeping ALL auth behaviour exactly (useAuth, loading, redirect when signed in with location.state.from, handleSubmit, error, submitting label + disabled, autoComplete/autoFocus/required, <LogoMark>). Decorative parts aria-hidden. Replace the file's cube-scene doc comments with accurate ones. Keep NoAccess.jsx looking right.
3. React pieces, only as the winning design needs them, each small with a short doc comment explaining why:
   - components/Preloader.jsx: the curtain, rendered once from D:/koti/YH-GRN/client/src/main.jsx; plays once per browser session (sessionStorage flag in try/catch — a failing storage must simply skip or play, never throw), never on route changes, pointer-events none, removes itself after the animation (animationend or a timeout), renders nothing under prefers-reduced-motion.
   - components/Backdrop.jsx if the design uses .app-backdrop spans or a pin-stripe layer element; mounted once in main.jsx.
   - A magnetic-hover hook only if it clearly earns its place; with listener cleanup, disabled for reduced motion and coarse pointers.
4. Match the codebase's comment style (short WHY comments). Update the top-of-file design description in styles.css to describe the new design honestly.
5. If a theme's --bg changes, update the literals in D:/koti/YH-GRN/client/index.html (pre-paint backgrounds) and D:/koti/YH-GRN/client/src/theme.js (theme-color).
6. Build check: cd /d/koti/YH-GRN/client && node scripts/build.mjs --outDir "${S}/impl-dist"   (NEVER build into client/dist, never commit).
7. Harness mirroring: the harness's built-in login markup is OLD and it has no Preloader/Backdrop. Write ${S}/candidates/impl/login.js mirroring your final JSX exactly (CANDIDATE_LOGIN, and CANDIDATE_BODY_START for whatever main.jsx mounts, CANDIDATE_INIT for any hook) and an EMPTY ${S}/candidates/impl/override.css. Shoot everything with css=impl (the real styles.css still loads first).
   Save and VIEW into ${S}/impl/: static light AND dark for results, upload, results sheet=1, noaccess, login, login error=1; width 420 for results and login in both themes; light login 1920x1080; real-time captures (capture.mjs) of light login, dark login, light results. Compare with the winners' own images; iterate until at least as good.

Return the structured result (filesChanged must list every repo file you touched).`, { label: 'implement', phase: 'Implement', schema: IMPL_SCHEMA })

if (!impl) return { error: 'implementation agent failed', themeRank, loginRank, judgements }

// ---------------------------------------------------------------- Verify
phase('Verify')
const HARNESS_NOTE = `Harness note: the implementer mirrored the real Login.jsx / main.jsx mounts / hooks into ${S}/candidates/impl/login.js. Before trusting it, compare it with D:/koti/YH-GRN/client/src/pages/Login.jsx, main.jsx and any new components; if they disagree, fix that scratch login.js to match the real code and say so. Shoot all pages with css=impl.`
const VERIFIERS = [
  {
    key: 'visual',
    prompt: `YOU ARE AN INDEPENDENT VISUAL AND MOTION QA REVIEWER. Assume the implementation has flaws and find them.
Read ${S}/ref/NSIDE-SPEC.md and view its reference frames first: the user asked for THAT look and animation.
Files changed: ${impl.filesChanged.join(', ')}. ${HARNESS_NOTE} Write output to ${S}/verify-visual/.
Check and VIEW: static light and dark for results, upload, sheet=1, login, login error=1, noaccess; width 420 for results and login in both themes; login at 1280x720 and 1920x1080 in light; real-time captures of light login, dark login, light results, dark results.
Hover/focus: a scratch stylesheet ${S}/candidates/qa-hover/override.css copying the new :hover/:focus/.is-active rules onto static selectors (e.g. .stat:nth-child(2), .nav-item:nth-child(4), the first .field__input), plus a login.js copied from candidates/impl so the markup matches; shoot with css=qa-hover in both themes.
Reduced motion: copy the chrome command from ${SB}/harness/shoot.sh, add --force-prefers-reduced-motion, shoot light login and light results at ms=300 and ms=3000 WITHOUT still=1: no preloader, no reveals, identical frames apart from nothing.
Look hard for: does it actually read as NSIDE; low-contrast text (muted text, table sub-text, placeholders, pills, tracked labels); motion that is too slow/long for daily use or leaves text skewed; the preloader lingering or covering content; clipped/overlapping/misaligned elements at any width; login unbalanced or templated; anything cheap. Report only real, evidenced issues.`,
  },
  {
    key: 'code',
    prompt: `YOU ARE AN INDEPENDENT CODE REVIEWER. Assume the implementation has bugs and find them.
Run: cd /d/koti/YH-GRN && git status && git diff  (an earlier redesign in this session is also uncommitted; focus on the NSIDE-style theme, motion, login, Preloader/Backdrop/hooks, main.jsx, index.html and theme.js, but flag any real bug you see). Ignore the untracked .wf-theme-redesign.js workflow file.
Check: Login.jsx keeps every auth behaviour of the previous version (git show HEAD:client/src/pages/Login.jsx); decorative elements aria-hidden; no dead controls or invented claims; NoAccess.jsx styled correctly. Preloader: once per session, sessionStorage wrapped in try/catch, never on route change, pointer-events none, unmounts/cleans up, nothing under reduced motion, StrictMode double-mount safe, no flash of content before it on first load vs. no stuck overlay if animationend never fires. Hooks: listener cleanup, reduced-motion and coarse-pointer guards. CSS: no transform/filter/will-change lingering on .table-wrap or its ancestors; fill-modes holding transforms on elements with :hover transforms; no size animations on large elements; every new animation off under reduced motion; background layers fixed + pointer-events none without creating containing blocks on html/body/#root/.app-shell; opaque --table-* tokens in both themes; light rules not leaking into dark; specificity conflicts; orphaned CSS from the removed cube scene or aurora; invalid CSS lightningcss would drop (build: cd /d/koti/YH-GRN/client && node scripts/build.mjs --outDir "${S}/verify-code-dist" and compare key rules in the output CSS with the source); index.html/theme.js literals match --bg; no external URLs; comments accurate. Report only real, evidenced issues with file:line.`,
  },
]
const reviews = (await parallel(VERIFIERS.map(v => () => agent(`${CONTEXT}\n\n${v.prompt}\n\nImplementer summary: ${impl.summary}\nImplementer notes: ${impl.notes || '-'}`, { label: `verify:${v.key}`, phase: 'Verify', schema: ISSUES_SCHEMA })))).filter(Boolean)

const allIssues = reviews.flatMap(r => r.issues)
const actionable = allIssues.filter(i => i.severity !== 'low')
log(`Verification: ${allIssues.length} issues (${actionable.length} high/medium)`)

let fix = null
let recheck = null
if (allIssues.length > 0) {
  phase('Fix')
  fix = await agent(`${CONTEXT}

YOU ARE THE FIXER. Independent reviewers checked the implemented NSIDE-style theme, motion and login. For each issue: confirm it is real (look at the code/images yourself), then fix it in the repo files. Fix every confirmed high and medium issue; fix low ones when cheap and safe. Skip anything you prove is not real, and say why.
Files changed by the implementer: ${impl.filesChanged.join(', ')}
${HARNESS_NOTE} If you change Login.jsx, main.jsx mounts or hooks, update ${S}/candidates/impl/login.js to match.

ISSUES:
${allIssues.map((i, n) => `${n + 1}. [${i.severity}] (${i.area}) ${i.description}\n   evidence: ${i.evidence}\n   suggested: ${i.suggestedFix}`).join('\n')}

After fixing: build (cd /d/koti/YH-GRN/client && node scripts/build.mjs --outDir "${S}/fix-dist"; never client/dist, never commit), then save and VIEW into ${S}/fix/: static light and dark results, light upload, light sheet=1, light and dark login, light noaccess, light login width 420; real-time capture of light login.
Return: summary of what was fixed/skipped (skipped items and reasons in notes), filesChanged, buildOk, screenshots.`, { label: 'fix', phase: 'Fix', schema: IMPL_SCHEMA })

  if (fix && actionable.length > 0) {
    recheck = await agent(`${CONTEXT}

YOU ARE A FINAL SKEPTICAL RECHECKER. A fixer claims to have resolved these high/medium issues:
${actionable.map((i, n) => `${n + 1}. [${i.severity}] ${i.description} (evidence: ${i.evidence})`).join('\n')}

Fixer summary: ${fix.summary}
Fixer notes: ${fix.notes || '-'}
${HARNESS_NOTE}

For each issue, verify in the current code and with fresh images (write to ${S}/recheck/) whether it is truly resolved, and whether the fixes introduced any new problem (check light and dark results, login and noaccess at least, a real-time capture of light login, and build once into ${S}/recheck-dist). Report only remaining or newly introduced real issues.`, { label: 'recheck', phase: 'Fix', schema: ISSUES_SCHEMA })
  }
}

return {
  themeRank,
  loginRank,
  themeWinner: themeWinner.name,
  loginWinner: loginWinner.name,
  designs: designs.map(x => ({ name: x.name, concept: x.concept, loginConcept: x.loginConcept, motion: x.motion, jsNeeded: x.jsNeeded, overrideCss: x.overrideCss, loginJs: x.loginJs, screenshots: x.screenshots })),
  judgements,
  impl,
  reviews,
  fix,
  recheck,
}
