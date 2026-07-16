# Agent Harness — AI Dev Tim

Web aplikacija koja orkestrira tim AI agenata koji zajedno rade na programerskim taskovima:

- **Team Lead (planer)** — ti zadaš **cilj**, team lead analizira workspace i pravi **plan taskova** koji ti stiže **na odobrenje**. Plan možeš da izmeniš (dodaš/obrišeš/preformulišeš taskove), vratiš sa primedbama na ponovno planiranje, ili odobriš.
- **Programeri** — AI agenti koji pišu kod. Odobreni taskovi se dele **na ravne časti** (round-robin) i rade se **simultano**.
- **Team Lead (code reviewer)** — pregleda svaku izmenu. Vraća `APPROVED` ili `CHANGES_REQUESTED` sa konkretnim primedbama; programer odmah kreće na popravke i vraća na review — petlja se vrti dok team lead ne odobri.
- **QA** — kada je task odobren, QA agent pokreće testove / smoke provere. `PASSED` → task završen (i commit-ovan u git); `FAILED` → vraća se programeru sa izveštajem.
- Kada su **svi taskovi završeni** → email notifikacija + zvučna/desktop notifikacija u UI-ju.
- **Izolacija taskova**: svaki task radi u svom git worktree-u (grana `harness/task-N`); posle QA se merge-uje u glavnu granu. Konflikt pri merge-u vraća task programeru na svežu bazu sa prethodnim diff-om kao referencom.
- **Zavisnosti**: planer označava `dependsOn` po tasku; zavisni taskovi čekaju da im zavisnosti prođu QA. Cikluse orkestrator automatski razbija.
- **Retry**: zaglavljen (STUCK) task se iz UI-ja vraća u rad jednim klikom, po mogućnosti drugom programeru; završen run se automatski nastavlja.
- **Troškovi**: praćenje tokena i procene cene po tasku, agentu i ukupno (uključujući prompt caching uštede).
- **Istorija runova**: svaki završen run se snima u `data/runs/*.json` i dostupan je u UI-ju.
- **Poruči timu uživo**: direktive celom timu ili pojedinačnom tasku tokom runa — ubacuju se u sledeće epizode.
- **Merge kapija**: opciono, task posle QA čeka tvoje odobrenje (uz diff viewer) pre merge-a u glavnu granu.
- **Završni integracioni QA**: posle svih merge-ova jedan QA agent verifikuje projekat kao celinu (uz browser smoke test za web projekte — `server/browser-smoke.mjs`, opciono zahteva playwright); pad otvara popravni task.
- **PR režim**: umesto lokalnog merge-a, task grana se push-uje i otvara se GitHub PR (`gh` CLI).
- **Limit pauza**: kad Claude Code pretplata udari u limit, run se pauzira 15 min pa nastavlja (umesto da taskovi popadaju).
- **Projektna memorija**: `HARNESS-NOTES.md` u workspace-u — agenti čitaju beleške na početku svake epizode i dopisuju naučene lekcije (merge=union, bez konflikata).
- **Procene i graf**: planer označava veličinu taska (S/M/L) uz procenu trajanja; graf zavisnosti se crta u planu i iznad borda.

**Nula zavisnosti** — čist Node.js (≥18). Nema `npm install`.

## Pokretanje

```bash
npm start
# → http://localhost:4400
```

(ekvivalentno: `node server/index.js` — nema zavisnosti, pa nema ni `npm install`)

Opciono, preko env varijabli:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # bez ovoga radi MOCK simulacija
export RESEND_API_KEY=re_...          # override ugrađenog Resend ključa
export RESEND_FROM="Agent Harness <noreply@tvojdomen.rs>"  # posle verifikacije domena
PORT=4400 npm start
```

Najjednostavnije: stavi ključeve u `.env` fajl u korenu projekta (server ga sam učita):

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Motor: API ključ ili Claude Code pretplata

Dva načina izvršavanja epizoda, biraš u UI-ju:

- **⚡ Claude API (ključ)** — direktni pozivi Messages API-ja (`ANTHROPIC_API_KEY` iz `.env`), plaća se po tokenu.
- **💳 Claude Code (pretplata)** — epizode se izvršavaju kroz `claude -p` (headless Claude Code CLI), pa se troše tokeni **uračunati u tvoju claude.ai pretplatu** (Pro/Max), ne API krediti. Potrebno: instaliran `claude` CLI + auth. Za pouzdan headless rad pokreni jednom `claude setup-token` (potvrdiš u browseru) i dobijeni token upiši u `.env` kao `CLAUDE_CODE_OAUTH_TOKEN=...` — to zaobilazi macOS keychain koji ume da blokira procese pokrenute iz servera. Harness pri pokretanju CLI-ja uklanja `ANTHROPIC_API_KEY` iz okruženja da CLI ne bi tiho naplaćivao preko API-ja. Napomena: paralelni programeri brzo troše 5-časovni limit plana; za veće timove smanji broj programera ili koristi API.

## Modeli po grupama

Lista dostupnih modela se **povlači sa Claude API-ja** (`/v1/models`) i biraš iz padajuće liste **poseban model za svaku grupu agenata**: programere, team lead (plan + review) i QA — npr. jači model za planiranje/review, jeftiniji (haiku) za QA.

## Radni prostor

- **Novi projekat** — kroz ugrađeni file browser izabereš folder u kom se kreira novi projekat + uneseš ime.
- **Postojeći folder** — file browserom izabereš postojeći projekat.
- **Git URL** — harness klonira repo.

## Email notifikacija (Resend)

Slanje ide preko [Resend](https://resend.com) API-ja — u UI-ju samo uneseš **na koji email** stiže notifikacija (+ dugme za test email). Ključ je u `server/mailer.js` (ili `RESEND_API_KEY` env var).

> Napomena: dok ne verifikuješ svoj domen na resend.com, Resend šalje isključivo na email vlasnika Resend naloga, sa adrese `onboarding@resend.dev`. Posle verifikacije domena postavi `RESEND_FROM` i možeš da šalješ na bilo koju adresu.

## Kako radi (tok)

```
CILJ ──► TEAM LEAD (plan) ──► 📋 PLAN → tvoje ODOBRENJE (izmene / primedbe / OK)
                                              │ odobreno
                                              ▼
taskovi ──round-robin──► PROGRAMERI ──► REVIEW QUEUE ──► TEAM LEAD
                             ▲                              │
                             │   CHANGES_REQUESTED          │ APPROVED
                             ◄──────────────────────────────┤
                             │                              ▼
                             │   FAILED (QA report)      QA QUEUE ──► QA AGENT
                             ◄──────────────────────────────┘
                                                            │ PASSED
                                                            ▼
                                              git commit + task DONE
                                    (svi done) ──► 📧 email + 🔔 notifikacija
```

- Svaki task ima state machine: `queued → coding → in_review → in_qa → done`, sa povratnim granama `needs_fix` (review ili QA).
- Zaštita od beskonačne petlje: posle 5 review/QA ciklusa task se označava `stuck` i run se ne blokira.
- Radni prostor: novi prazan projekat, postojeći folder ili `git clone` URL. Ako folder nije git repo, harness ga inicijalizuje da bi reviewer dobijao prave diff-ove, a QA-prošli taskovi se commit-uju.

## MOCK mod

Bez API ključa agenti simuliraju rad (programer "piše" fajl, team lead prvi put traži izmene pa odobri, QA prolazi). Idealno da proveriš ceo tok pre nego što potrošiš tokene.

## Agenti — kako su implementirani

Svaki agent je **agent-loop direktno preko Claude Messages API** (bez SDK-a): system prompt uloge + tool-use petlja sa alatima `list_dir`, `read_file`, `write_file`, `run_command` (ograničeni na workspace). Petlja se vrti dok model ne vrati konačan odgovor (limit 40 iteracija po epizodi), sa retry/backoff na 429/5xx.

## Struktura

```
server/
  index.js        HTTP server + REST API + SSE stream + /api/models + /api/fs
  env.js          učitavanje .env fajla
  compat.js       fetch polyfill za Node < 18
  orchestrator.js plan, worktree izolacija, zavisnosti, review/QA petlje, merge, retry, troškovi
  agent.js        agent-loop preko Claude API (tool use)
  tools.js        alati agenata (fs + shell, sandboxovani na workspace)
  roles.js        system promptovi: planer / programer / team lead / QA
  mock.js         simulacija bez API ključa
  mailer.js       slanje emaila preko Resend API-ja
public/
  index.html      ceo UI (bez frameworka)
```

## Poznata ograničenja (v1)

- Paralelni programeri dele isti workspace — najbolje je da taskovi ne diraju iste fajlove. (v2 ideja: git worktree po programeru + merge posle QA.)
- `run_command` izvršava komande na mašini gde server radi — pokreći u sandboxu/kontejneru ako daješ nepoverljive taskove.
- Review diff se pravi od fajlova koje je programer izmenio kroz `write_file`; izmene napravljene isključivo kroz shell komande reviewer vidi kao listu bez diff-a.
