# ANALYSIS — "What it takes to build a software factory" (Warp)

## 1. Metadata

| | |
|---|---|
| Title | What it takes to build a software factory |
| Channel | Warp |
| Speaker | **Zach Lloyd** — founder & CEO of Warp; previously principal engineer at Google, ran engineering on Google Docs (stated at 00:00 and 00:42; the logged-in user in the product UI is "Zach Lloyd / Engineering") |
| Duration | 25:51 (1551 s) |
| URL | https://www.youtube.com/watch?v=x-PK3yx_MJg |
| Source resolution | 3840x2160 advertised; downloaded 1920x1080 @ 23.976 fps |
| Captions | manual English track (`caption_source: manual`) — quoted text below is verbatim from it |
| Transcript | `transcript.json` (172 segments), `transcript.md`, `transcript.txt` |
| Frames | 131 PNGs in `frames/` (dense 9:00–12:30 grid @ 2 s, plus targeted screenshots and 10 scene cuts) |
| Video file | kept — `video.mp4`, 72.7 MB (well under the 1 GB delete threshold) |

This is a recorded conference-style talk with a live product demo. Roughly 60% is
argument, 40% is screen recording of Warp Factories, Slack and GitHub.

## 2. Timestamped outline

| Time | Section |
|---|---|
| 00:00–00:53 | Intro, who Zach is, why he's giving this talk |
| 00:54–01:28 | What Warp is: agentic dev company, Warp Factories platform, Warp terminal (~65k stars, ~1M devs) |
| 01:28–02:26 | The arc of agentic development: autocomplete → local Claude Code/Codex → automated factories |
| 02:26–03:35 | Why interactive agents don't scale: people bottleneck, cost, governance/security; sandboxing |
| 03:35–04:14 | Definition of a software factory (cloud, human+agent loop, measurable/improvable) |
| 04:14–05:06 | The loop: intake → triage → spec → implement → review → computer-use QA → CI/CD → monitor |
| 05:06–06:43 | Factories as infrastructure: open, composable, any model/harness; defined in code; AI sovereignty |
| 06:43–07:55 | Open vs walled garden; measuring on your own workflows instead of public benchmarks |
| 07:55–08:53 | Two jobs: product engineering and **factory engineering** |
| 08:53–09:38 | Demo starts: the factory-engineer dashboard; one factory per product surface |
| 09:38–10:16 | The foreman agent: centralised config, automations, prompt, delegation |
| 10:16–11:07 | Stock factory stages; interacting from any surface; context must live in the cloud |
| 11:07–12:14 | Product-engineer flow: Slack request → triage → Linear issue → PR → computer-use proof |
| 12:14–13:09 | Real-time visibility across the team ("Google Docs for coding agents") + automatic run storage |
| 13:09–14:03 | Factory-engineering metrics: human interactions/PR, cycle time, cost/PR, slicing |
| 14:03–15:23 | Scoring: LLM-as-judge evals on real runs, sampling, pass/fail, defined in code |
| 15:23–17:13 | Self-improvement: agents find repeated failures and PR fixes to the factory definition |
| 17:13–18:01 | Automations as first-class entry points (may be where you start) |
| 18:01–21:38 | Benchmark suites on your own tasks: replay, model/harness matrix, correctness-vs-cost Pareto curve, model routing |
| 21:43–24:49 | The factories stack (00–06) |
| 24:49–25:11 | Positioning: platform teams; "go try Warp Factories" |
| 25:11–25:51 | Results: cost/PR $55 → ~$15 in six weeks, +40% PR throughput, lower revert rate; closing conviction |

## 3. Every distinct idea and claim

### 3.1 The three failure modes of local/interactive agents
> "the problems the world has with these interactive agents are, first, you're totally
> bottlenecked by people… Interactive agents also have all sorts of problems with cost
> management. They're very hard to collectively optimize because everyone's doing their
> own thing. And the third thing is there's no central layer for governing them, so there
> are all sorts of security problems." — **02:49**

> "when everyone is using local agents, everyone's setting up their own MCPs. If something
> gets compromised, it's compromised as the logged-in user. They're hard to govern. The
> solution here is generally going to be to sandbox them." — **03:13**

Note the framing: this is a *governance* argument, not a capability argument. The agents
are good enough; the deployment model is wrong.

### 3.2 What a software factory is (the definition)
> "It's an agentic loop where humans and agents collaborate. It runs in the cloud. You
> can't have a local software factory because you can't have automations running off your
> laptops. And the really key thing is that it's a measurable, improvable system that you
> can do what I call factory engineering on, so that you can actually make the system
> better over time." — **03:35**

Three tests fall out of this: (a) cloud-hosted and always-on, (b) humans inside the loop
rather than outside it, (c) instrumented well enough to be improved deliberately.

### 3.3 The loop / stages
> "ideas come in from various sources. It could be directly from a person. Then agents do
> some amount of work, whether it's triage or spec. They might loop a human in to work on
> a spec together. Agents implement, they do code review, they might loop a human in for
> code review, they do computer-use verification and QA, they go through CI/CD to ship,
> and then they do some amount of monitoring." — **04:14**

> "This loop is going to look different in its details at every company, on every team. So
> this isn't meant to be one-size-fits-all. But a software factory should support building
> different variants of this loop. It could be for the software lifecycle or for the
> broader product lifecycle." — **04:47**

Explicitly not a fixed pipeline: the product must let each team instantiate its own variant.

### 3.4 Factories are infrastructure, and infrastructure must be open
> "the right way to view software factories is as infrastructure, and that infrastructure
> should be as flexible as GCP or AWS. Specifically, that infrastructure should be open,
> meaning you should be able to put in any model, any harness, and use it in your factory.
> It should be very composable, pluggable, and really adaptable." — **05:12**

> "The only way the software factory approach is going to work for companies at any kind of
> scale is if you can set it up to work with your existing tools and systems." — **05:37**

### 3.5 Definitions as code (the load-bearing claim)
> "software factories should be defined in code. You should declare what your software
> factory actually is. You should say, 'These are all my agents and MCPs, these are the
> repos they operate on, these are the skills they use.' And it should be versioned. Once
> you do this, it creates opportunities: how do you test different versions of a factory?
> How do you let agents self-improve a factory? … It's got to be a real declarative
> system." — **05:48**

This is the hinge of the whole talk: code-defined factories are what make versioning,
A/B testing, rollback **and** machine-generated improvements possible. Without it,
self-improvement has nothing to edit.

### 3.6 AI sovereignty / own your data
> "if you're building one of these factories, you should really try to keep all the data
> going through it on your own systems. That data is what you're going to use to improve
> your agents, and you don't want someone else having it." — **06:18**

> "It should be flexible enough to run on your own compute. You might want to run your own
> models. It should be able to run with your own inference gateway, and it should be able
> to use any model in any harness. So I think open is going to win here, as opposed to a
> walled garden, single-vendor solution." — **06:43**

### 3.7 Measurement instead of benchmark vibes
> "on any given day you might have the sense that there's a new best harness or a new best
> model. It's hard to tell who has a conflict of interest when they're talking about
> things. The solution is to get a system in place where you can measure how coding agents
> are doing on your own workflows. That means having LLM-as-a-judge evals on all your
> coding agent sessions, using those evals to drive a self-improvement loop, and being able
> to benchmark different configurations. So you can actually, instead of using SWE-bench or
> Terminal-Bench, prove to yourself that you have the right setup." — **07:11**

### 3.8 Two engineering jobs
> "There's product engineering, which is still going to matter… But product engineering is
> going to happen through a factory, meaning work is going to go into this closed-loop
> system, and humans are going to have touch points with it. Then there's factory
> engineering… the job of taking your software factory and making it more efficient. It's
> really a lot of performance tuning: figuring out what skills and MCPs, what model mix,
> and what workflow are right, so that your whole team doing product engineering can do it
> better." — **07:55**

"Factory engineering" is the new role the product is built around — the dashboard is
explicitly "what the factory engineer is going to use" (09:09).

### 3.9 One factory per product surface; the foreman
> "you have one factory per product surface. The way to think about that factory is as a
> collection of agents, and this collection of agents is defined in code." — **09:17**

> "We provide a default implementation where all work that comes into the factory goes
> through what we call a foreman agent. If you look at this foreman agent, it has all of
> the centralized configuration: what MCPs does it need? What are the secrets? What model
> does it use? Where does it run? You can see what automations it can be triggered by. And
> you can see the prompt for this foreman agent. When work comes in, it delegates it to
> other agents using an orchestration pattern." — **09:38**

> "This is our stock factory, but you can think of it as going through that loop. You do
> triage, specs, implementation, and code review." — **10:16**

The foreman is the *only* agent with centralised config (MCPs, secrets, model, harness,
runner); sub-agents are dispatched per stage. The prompt itself (visible on screen at
10:04) makes the economics explicit: "Your objective is to reach the user's goal at the
lowest cost that gets there. The stages below get more expensive as the work moves forward:
a message is cheap, an issue is cheap, a spec costs a round of review, and implementation
is by far the most expensive stage in time, compute, and tokens. A question asked before
implementation is cheap."

### 3.10 Any surface, but context in one place
> "you can do it from any surface… this isn't how we expect folks to interact with
> factories. I think you should be thinking about factories by integrating them into your
> existing tool set. For instance, at Warp, the tool we primarily use at this point is
> Slack. But we have customers who use Teams, Linear, Jira, and GitHub. It doesn't matter
> where you interact, because all of the context for your factory needs to be in the cloud,
> in one central place." — **10:27**

### 3.11 The product-engineer path
> "This is Varun on our team asking for some changes. It goes through a flow, and work goes
> to the foreman. What's different from just using a regular coding agent is that along the
> way, it goes through the triage step and all the steps we define in the actual workflow."
> — **11:12**

> "Here, it's created the Linear issue. I could interact with this in Linear if I wanted.
> In the same way, it's created the server PR, and it's done computer use, so it's proven
> that it's done the right thing." — **11:47**

> "as a product engineer, you're working through the tools you already use… In many ways,
> this is the least interesting part of the factory approach." — **12:14**

### 3.12 Centralisation is the prerequisite for factory engineering
> "not only do you define your factory workflow in code, but you also get the ability to
> see in real time what everyone on your team is doing across all the factories you're
> working on. Think of this almost like Google Docs, but for your team's coding agents." — **12:37**

> "it's all centralized. When you centralize it, not only do you get this real-time view,
> but you get automatic storage and tracking of everything people on your team are doing
> with coding agents. Once you have that, you can actually start doing factory
> engineering." — **13:03**

### 3.13 The metrics that matter
> "How many human interactions are there per PR? How automated are you? How long does it
> take to ship? How much money are you spending per PR? Slicing that by different sources,
> by user, by agent, by model. Calculating and knowing your cost per PR, and having a plan
> in place to drive it down." — **13:29**

Four axes: **autonomy** (human touches/PR), **speed** (cycle time), **cost** (per PR), and
the ability to slice all three by source/user/agent/model.

### 3.14 Scorers: LLM-as-judge on your own runs
> "Once you're in a world where… all of your coding agent runs are stored, you get the
> ability to run LLM-as-a-judge over them to evaluate them along different dimensions. One
> of the dimensions we look at at Warp is redundant tests… there's a common failure mode
> where coding agents waste a bunch of money, time, and context writing unnecessary tests.
> So we have agents look at our past agent runs using LLM-as-a-judge to figure out where
> we're experiencing this failure mode. We don't do this on every run because it's kind of
> expensive, but there's a sampling strategy and pass/fail criteria. And all of this, again,
> is defined in code." — **14:18**

Key design details visible in the UI: each scorer is a **weighted classification scheme**
(e.g. `no_surplus_tests = 1`, `insufficient_evidence = 0.5`, `some_surplus_tests = 0.4`,
`mostly_surplus_tests = 0.2`), a **pass threshold** (0.50), a **sample rate** (10%), and a
**self-improvement toggle**.

### 3.15 Self-improvement: agents edit the factory
> "once you have this type of system in place [you can] set up another loop, which we call
> self-improvement, where agents look at these failed runs and try to suggest changes to
> improve the underlying factory." — **15:23**

> "we have agents looking at all of these scores. They find repeated problems. Here's one
> that was identified as a problem with our triage agent. We saw this 54 times. Then they
> suggest improvements to the definition of the factory itself to fix the problem… This is
> why it's so important to define everything in code: you have coding agents observing
> problems in how your company is producing software. They observe it on a repeated basis.
> They're smart. They say, 'Okay, the actual underlying problem is with the way the factory
> itself is specified, and we can suggest a fix.' Then they make a PR that we can merge into
> the factory definition, so this problem doesn't occur again. This is what we call
> self-improvement." — **16:02**

> "No matter how you approach this, it's a very useful primitive for getting to a loop where
> your factory actually gets better over time." — **17:13**

Crucially: the loop terminates in a **human-merged PR against the factory definition**, not
an autonomous config mutation. The demo PR (#1059, at 16:14) is a one-line fix
(`spawnableBy: [foreman, triage]`) justified by "54 failed runs" and scorer evidence.

### 3.16 Automations as entry points
> "The goal is to have a similar flow for work coming in through automation triggers. If
> you're building a factory, this might even be where you start. You should have a way of
> saying, in addition to a direct human prompt, we want an automated prompt or trigger that
> puts work through this exact same factory workflow, or a slightly different one. So your
> factory should support a set of automations." — **17:24**

Practical advice hidden here: **start with automations**, not with chat. A scheduled digest
or a "PR merged → follow-up" trigger is a lower-risk first factory workload than open-ended
feature requests.

### 3.17 Benchmarks on your own tasks
> "you want to be able to truly measure how coding tasks perform with different models and
> different factory configurations on your own real workflows… for anything being done
> within a Warp factory, you have the ability to say, 'This is an interesting task.' Maybe
> it's a hard task, or a specific class of task, like a frontend engineering task. You can
> add it to a benchmark… because you're tracking all of your coding agent sessions, you have
> the ability to rerun and replay them. You have to be thoughtful about how you do this with
> side effects… you can say, 'I want to test how things perform against different model
> configurations.' You can test against different harness configurations. I could see how it
> does in Pi." — **18:01**

> "it runs a matrix of tests against your own real coding agent tasks, and then produces
> something that looks like what you get with one of the public benchmarks… It generates a
> correctness-versus-cost trade-off curve… the further up and to the left, the better,
> because left is cheaper and up is higher quality." — **19:27**

### 3.18 Cost/ROI numbers (the only hard numbers in the talk)
> "You can see the two candidate models for winning this benchmark, along this Pareto curve,
> are GPT-5.6 Sol. We ran this one a while ago. It cost $6.23 on average but got 95% correct.
> And GLM-5.3 Flash, which was a third of the cost and just a little less correct… for these
> types of tasks, you can make an educated trade-off on whether you prefer slightly higher
> quality at three times the cost. I'd say we would probably choose GLM-5.3 Flash for this,
> honestly." — **20:26**

> "Then you can feed this into a model routing strategy that applies to similar tasks." — **21:01**

> "instead of relying on Terminal-Bench or SWE-bench, which are cool and useful for general
> intelligence… you say, 'For our own work, what's best?'" — **21:14**

> "I usually have a slide in here about how we've lowered Warp's cost per PR from about $55
> to around $15 in the last six weeks, while increasing our PR throughput by about 40% and
> having a lower revert rate. So this isn't just putting out slop." — **25:11**

On-screen benchmark data (20:05) corroborates the shape: `glm 5.3 flash` at ~$1.99/trial,
93% correctness; `gpt-5.6-sol (high)` at ~$6, 95%; `claude opus 5 (high)` ~91.5% at ~$15;
`grok 4.6 (high)` ~93%; `gemini 3.7 flash` ~89%.

### 3.19 The stack
> "The way we tie this all together… is by thinking of software factories as a stack." — **21:43**

> "At the bottom of this stack is the definition of factories as code… that unlocks
> versioning, testing, and rolling back all of the configuration for how your factories
> work, which really means how software development, agentic development, works at your
> company." — **21:49**

> "The second piece above that is a data and context layer… all the data coming into the
> factory, from MCPs or from APIs, and all the data coming out of the factory. That could be
> agent runs and transcripts, which I'd say is the most important thing, but agents also
> produce things like screenshots and videos, and there's a memory concept." — **22:14**

> "The third layer to think about is compute: where do your agents run? … you want them to
> run in sandboxes for security and governance reasons. Depending on requirements, you may
> want to support sandboxes across multiple platforms. Inference should be pluggable… Most
> companies we talk to want to bring their own inference… open-weight models, frontier
> models… a fine-tuned model they've built." — **22:45**

> "Improvement primitives that let you close the loop and actually improve your factories:
> very important. Orchestration: what steps or stages do you want your process to go through?
> How do you gate those with human gates and determinism, while also taking advantage of the
> fact that agents are intelligent and can do intelligent routing? Again, this should support
> multiple harnesses and multiple automation primitives." — **23:17**

> "a really important primitive for building a factory is supporting all sorts of access
> points into the factory… That work can come in via MCP, through Slack or Teams, through
> Jira, Linear, GitHub, or GitLab. You should be able to build your own UI on top of it. It
> should all be API-driven." — **24:01**

### 3.20 What fails / what to watch out for
The talk has no "postmortem" section, but the failure modes are named in passing:

- **Slop** — the explicit fear behind the metrics: "make sure it's not sloppy and the
  quality isn't bad" (02:26), "this isn't just putting out slop" (25:26).
- **Local MCP sprawl** — per-developer MCP servers, compromise = logged-in-user compromise (03:13).
- **Cost opacity** — "very hard to collectively optimize because everyone's doing their own
  thing" (02:58); fixed by per-PR cost accounting and slicing.
- **Redundant tests** — the canonical wasted-work failure mode, costing "money, time, and
  context" (14:41).
- **Repeated process failures** — the triage agent that didn't spawn research subagents, seen
  **54 times** before the factory was fixed (16:02); the same class shows up in the UI as
  "54 failed runs".
- **Benchmark replay side effects** — "You have to be thoughtful about how you do this with
  side effects" (19:13). No solution is given; this is an acknowledged hard problem.
- **Merge-queue / CI friction** — visible in the Slack demo at 12:14–12:30: the agent reports
  PR #19903 approved, then "removed from the merge queue", then re-checked. The loop is not
  frictionless.
- **Scoring cost** — "We don't do this on every run because it's kind of expensive" (15:03);
  hence sampling.
- **Incomplete scores** — the benchmark screen itself warns "Some plotted scores are based on
  incomplete scorer results… 28/29 tasks scored".

### 3.21 How to start (advice, explicit and implicit)
Explicit:
1. **Define the factory in code** before anything else — versioning/testing/rollback depend on it (05:48, 21:49).
2. **Integrate into tools people already use** rather than building a new chat surface (10:40).
3. **Start with automations** if you're building from scratch (17:24).
4. **Measure cost per PR and drive it down** — have "a plan in place" (13:55).
5. **Sandbox agents, own your data, measure** — the closing slide (24:39).

Implicit, from the demo:
6. Keep **one factory per product surface** (09:17) — don't build one mega-factory.
7. Put **all shared config on one orchestrator** (foreman) and keep sub-agents thin (09:38).
8. Give every run a **cost readout** in the interface where humans already are (Slack messages show `$8.62`, `$6.50`, `$7.26`).
9. Make self-improvement **propose PRs**, not auto-apply (16:46).

## 4. UI walkthrough

### 4.1 Confirmed navigation map

Your expected list is **confirmed**, with two corrections/additions:

```
┌ top-level ────────────────────────────────
  New Chat
  Inbox
  Runs
  MCPs and apps
  Secrets
  Users
┌ Factories  [+]                              ← section header, "+" = new factory
  ▾ wilson                                   ← factory switcher (icon + name + pin + caret)
      Dashboard
      Agents
      Automations
      Scorers
      Self-improvement            [33]        ← count badge
      Benchmarks
      Factory definition
      Settings
  ▾ Mediation Factory                        ← second factory, collapsed
  ▾ Marketing Factory                        ← third (seen after scrolling)
  ▾ Internal app fact…                       ← truncated
  ▾ Backend
┌ bottom ───────────────────────────────────
  ● Usage available                          ← green dot status row
  Zach Lloyd / Engineering                   ← account menu
```

- "MCPs and apps" — exactly as you expected.
- "Self-improvement" — hyphenated, with a **numeric badge** (33) that matches the number of
  open self-improvement items in the Inbox.
- **Correction:** `Dashboard / Agents / Automations / Scorers / Self-improvement / Benchmarks /
  Factory definition / Settings` is **per factory**, not a single global group. Factories are a
  collapsible list with a "+" to add one, and each factory carries its own pin/caret.
- **Additions you didn't list:** the factory switcher itself (multiple factories visible:
  wilson, Mediation Factory, Marketing Factory, Internal app fact…, Backend), the
  "Usage available" status row, the account footer, and search + collapse icons in the sidebar
  header.
- `Inbox`, `MCPs and apps`, `Secrets`, `Users`, `Factory definition` and `Settings` are **never
  opened** in the video — only visible as nav items. I did not invent their contents.

### 4.2 Screen-by-screen (9:11 → 12:30, plus later pages)

#### A. Dashboard — `wilson > Dashboard` (visible 08:50 → 09:32, and again 13:25)
Breadcrumb `wilson › Dashboard`. Top-right: **"Last 7 days"** dropdown + ⓘ. Three tabs:
**Productivity · Spending · Scorers**.

*Productivity tab* (4 panels, Oct 9–15 axis):
| Panel | Content |
|---|---|
| Human interactions per PR | big number **21.5**, orange line chart |
| Median cycle time | 2×2 grid: **Kickoff → merge 15h**, **Kickoff → PR 44m**, **PR → first human review 2.6h**, **First human review → merge 27m** |
| Pull requests | **325** (subtitle "189 merged"), legend **Opened** (purple) / **Merged** (orange), two lines |
| Total runs | **1,789**, "743 top-level runs", dropdown **"By agent type"**, stacked area with legend **Foreman, Code, Review, Triage, Spec, Custom** |

Sidebar scrolling at 09:17–09:32 reveals the other factories (Marketing Factory, Internal
app fact…, Backend) and per-factory sub-navs with different badge counts (Marketing
Self-improvement 17, wilson 33).

#### B. Agents — `wilson > Agents` (09:38 → 09:42, 10:22 → 10:42)
Toolbar: 🔍, filter icon, **New ▾**, ⓘ.
Banner: **"Managed in GitHub — Configuration is read-only here. Make changes in
`warpdotdev/factory-dev` at `main:v1`."** + **Open in GitHub**.

Foreman card (orchestrator icon, purple): title **wilson Foreman**, description
*"Orchestrates the factory workflow and dispatches each gated step."*, buttons
**＋ New chat** and **Import**.

Grid of agent cards, each with an icon, a name, a one-line description and a ⋮ menu:
- `code-review` — "Reviews factory pull requests and routes findings to rework or human resolution." (pink speech-bubble icon)
- `implementation` — "Implements, validates, and updates code changes." (`</>` icon)
- `spec` — "Writes and drives approval of specifications." (orange doc icon)
- `triage` — "Triages requests and establishes task state." (dotted-circle icon)
- `design` — "Interviews the user to understand the underlying user story, then builds…" (browser-window icon, partially visible at 10:34)

#### C. Agent detail — `wilson > Agents > foreman` (09:44 → 10:16)
Top-right **Save**. Tabs **Prompt · Automations · Settings**.

*Settings tab* (09:54):
- **Description** — "Orchestrates the factory workflow and dispatches each gated step."
- **Agent resources** (link "View defaults"):
  - **MCPs**: `Linear (Warp managed)`, `Slack (Warp managed)`, `figma`, `grafana`, `sentry`, `staging_maa_debugger`
  - **Secrets**: `TUL_AUTH_KEY`, `WILSON_SENTRY_AUTH_TOKEN`, `SUGGESTION_BOX_SLACK_WEBHOOK_URL`, `COMPLAINT_SLACK_WEBHOOK_URL`
  - **Harness**: `Warp`
  - **Model**: `gpt-6.1-sol (high)`
  (This is the "centralized configuration" Zach narrates at 09:49 — MCPs, secrets, model, where it runs.)

*Prompt tab* (10:04): **Agent prompt** — "This is the base prompt the agent will use." Body starts
`# Foreman` / *"You are the orchestrator ("foreman") of the software factory. The factory is a
team of agents that automates the software development lifecycle from start to end. You accept
work into the factory and keep the work in motion. For the most part, you do not do all the work
yourself; you delegate to subagents to handle different parts of the lifecycle, like triage and
code review."* Second paragraph is the cost hierarchy quoted in §3.9.

*Automations tab* exists but is never opened.

#### D. New Chat / new run — `Runs > New run` (10:44 → 10:56)
Greeting **"Good afternoon, Zach"**, a single composer with a repo selector chip
(`[deprecated] dataland-…`) and a send arrow, and the helper link **"How to chat with the
factory foreman in your connected apps"**. Sidebar highlights **New Chat**. (The macOS dock
floats over the recording here — an artifact, not UI.)

This is the "you *can* talk to it here, but we don't expect you to" surface from 10:27–10:40.

#### E. Slack — `#factory` channel (10:56 → 11:44, and 12:14 → 12:30)
Full Slack window (sidebar: Threads, Huddles, Drafts, Saved, Directories, External
connections, Channels list with `#factories-sales-bugs-and-papercuts`, `#grain-recordings`,
`#pod-factories-debuggability-reliability`, `#pod-hosted-data-store`, `#pod-network-controls`,
`#pod-sandblast`, `#dataland-factory-input`, `#factory`; DMs with named engineers).

Messages to **@wilson** (the foreman, with an APP badge):
- 5:11 PM Harry Albert — "right now for ACP conversations (just pi at this point), I think…
  we're polling the transcript every 10 seconds instead of just tapping into the session
  sharing stream like we do for the warp harness… We should also enable image attachment in
  the factory chat".
- 5:50 PM Varoon Kodithala — a PR stack that "adds support for a user-configurable
  self-improvement prompt": *"starting to use the 'autofix' named agent for self-improvement
  rather than foreman"*, *"adding a new recognized `selfImprovement` section to the factory
  file format"*, *"scorers define their defaults in a `scorerDefaults` section of factory.yaml"*,
  *"we should update `service_accounts[self-improvement identity]`"*. Attachments: an agent
  settings screenshot (model `gpt-6.1-sol (medium)`, Harness Warp, "5 failed runs", custom
  list with @mentions, scorer rows: Change Requested, Redundant Tests, Integration MCP Loss,
  Unnecessary Test Removal Correction, Inefficient Git History Command, Complete Task
  Compliance, …) and a **"sample / test benchmark"** card with **Runs / Tasks** tabs.
- 4:58 PM Dagm — "@wilson can you truncate toolcall tooltips on factory chat? I don't have a
  good sense of what is a good length to truncate at."
- **@wilson APP** replies inline with a **cost per message** (`$0.82`, `$6.50`, `$7.26`,
  `$7.29`), a **"View in factory"** deep link, PR links (`APP-6366 - warp-server#19903`), and
  state narration ("The six-line preview is working in Factory chat…", "Your approval is
  recorded on PR #19903", "PR #19903 is approved and has no failing checks… it remains open,
  awaiting checks and is queued", "PR #19903 was removed from the merge queue… I'm checking
  the reason").

This screen is the strongest evidence for "the factory meets people where they are": the whole
agent interaction, including cost and approval, happens inside a chat thread.

#### F. GitHub — PR #19903 (11:48 → 12:00)
`warpdotdev / warp-server`, PR **#19903 "[APP-6366] Truncate oversized Factory chat tool-call
tooltips"**. Badge **Merged**, by `dagfactory`, `develop ← factory/truncate-tool-call-tooltips`,
Oct 15 2026. Tabs Conversation / Commits 1 / Checks / Files changed. Bot comment by
`warp-agent-staging` structured as **What / Why / New Server APIs / New database tables**;
label `factory:wilson`; Reviewers `dagfactory ✓`; Development: "Successfully merging this pull
request may close these issues."

#### G. Runs — global `Runs` (13:10)
Breadcrumb just `Runs` (not per-factory). Filter row: a dismissible **"My runs"** chip plus a
**"wilson"** chip, then tabs **Running · Complete · Failed · Blocked · Cancelled** and a
**"Show background runs"** toggle. Rows: status icon (green ✓ = complete, grey = blocked,
orange = failed), title, source chips (**Slack**, **Warp Web**, **2 Images**, **PR 18…**),
author avatar, relative time ("1 day ago", "3 days ago"). Titles are real work items:
"Fix Scorers View Bug in Wilson Dev", "Review Factory Chat vs Slack Thread Info", "Add Factory
Indication to Run Rows", "Design Revamp for Factory Chat Panel", "Investigate 500 Errors
Loading Metrics", "Verify Model Deprecation Impact".

This is the "Google Docs for coding agents" view from 12:37–13:03.

#### H. Dashboard → Scorers tab (14:10 → 14:45)
Grid of scorer cards. Each: name + ⓘ, big **pass %**, "N passed · M failed", sparkline over
Oct 9–14, and agent chips at the bottom.

| Scorer | Pass | Counts | Agents |
|---|---|---|---|
| Change Requested | 95% | 83 passed · 4 failed | foreman |
| Slack MCP Reply | 97% | 87 passed · 3 failed | foreman |
| Computer-Use Ask | 99% | 84 passed · 1 failed | foreman |
| Redundant Tests | 96% | 27 passed · 1 failed | implementation |
| Integration MCP Loss | 98% | 159 passed · 4 failed | code-review, foreman, implementation, spec, "Show 1 more" |
| Status Update Nudge | 94% | 81 passed · 5 failed | foreman |
| Unnecessary Test Removal Correction | … | … | … |
| Inefficient Git History Command | … | … | … |
| Complete Task Compliance | … | … | … |

#### I. Scorer detail — `wilson > Scorers > Redundant Tests` (15:10)
- **Classifications*** — "Define specific criteria that should result in the agent receiving
  either a passing or failing score." Weighted rows, green = passing, red = failing:
  - `1` **no_surplus_tests** — "Every added test or case would fail on a real defect no other added or existing test catches, or the change i…"
  - `0.5` **insufficient_evidence** — "The transcript has no usable final test diff — truncated, no files, or a behavior change with no tests added —…"
  - `0.4` **some_surplus_tests** — "One or two low-signal cases sit beside otherwise justified coverage, or a minority of added tests/cases are…"
  - `0.2` **mostly_surplus_tests** — "A material share of added tests/cases are redundant, tautological, flag/config getters, unchanged-code rest…"
  - **＋ Add classification**
- **Pass threshold*** — slider at **0.50** ("Set a score threshold for what counts as a pass (0 to 1)")
- **Sample rate*** — slider at **10 %** ("Select how frequently this scorer should run across eligible agent runs")
- **Self-improvement*** — toggle (off): "When turned on, Self-improvement will analyze failing runs in order to suggest improvements to your…"

#### J. Self-improvement — `wilson > Self-improvement` (15:30 → 16:12)
Top-right: 🔍, filter, **Run now**, **Configure** (black).
- Tabs **Approval · Cost**
- Timeline chart, legend **Approved** (purple) / **Rejected** (pink) / **Pending review** (grey);
  caption "Changes grouped by PR or review opened time."
- Sub-tabs **Inbox · Needs review · Approved**, right-aligned **View all runs**
- Inbox rows: agent icon (foreman / implementation / code-review / design), bold title,
  one-line rationale in italics, **Open ↗** button, relative age.

Rows seen (15:50):
| Age | Title | Rationale (excerpt) |
|---|---|---|
| 8h | Report failed task closeout instead of silently ending | "A run received a failed complete_task result because its Factory task was cancelled, then ended without reporting that failure." |
| 17h | Deliver the final reply before completing the task | "The completion procedure lists task closeout before sending the final reply, conflicting with Slack's delivery-before-closeout rule." |
| 1d | Keep Go module files tidy after dependency changes | "A Go dependency update left obsolete go.sum entries…" |
| 9d | Report only findings and unexamined dimensions in reviews | "The code-review skill told reviewers to account for every dimension in the findings, clean ones included…" |
| 9d | Handle CI failure follow-ups without a plan-only skill | "…the implementation agent read the 'diagnose-ci-failures' skill, whose required output is a plan docum…" |
| 11d | Make design snapshot lookup and pre-write locate step satisfiable | "Design runs were scored noncompliant for never reading the required design-system snapshot…" |
| 14d | Trust the duplicate-check helper's credibility judgment | "In the Linear duplicate-checker automation, the Foreman discarded the helper's returned matches as not credible…" |
| 14d | Read matching repository skills before implementing | "Implementation runs in warp-server skipped repository skills that were in their available skills list…" |
| 14d | Keep code-review text output to the single verdict report | "The code-review agent still emits plain-text progress narration between tool calls…" |

Expanded item (16:05) **"Let triage start research subagents"**:
- **PROBLEM** — "Triage is told to delegate broad investigations to the research skill, which
  requires starting local child agents, but the triage agent declares no `spawnableBy`, so the
  platform leaves it without spawn permission and it investigated inline in about 25 of the
  scored runs."
- **SOLUTION** — "Declare `spawnableBy: [foreman, triage]` on the triage agent so it keeps being
  dispatched by foreman and also gains explicit self-spawn permission to start the local
  research subagents its instructions already call for."
- Footer: `warpdotdev/factory-dev · triage · **54 failed runs** · ↗ Self-improvement run`

#### K. GitHub — PR #1059 (16:14)
`warpdotdev / factory-dev`, PR **#1059 "Let triage start research subagents"**, **Draft**,
`warp-agent-staging[bot]` wants to merge `factory/triage-spawn-research` → `main`. Body is
**Problem / Solution / Evidence** with source paths (`logic/ai/multi_agent/agents/primary/agent.go`,
`model/types/service_account.go`), run IDs (`01a0b53d`, `01a0cea8`, `01a0d3f4`, `01a0ac69`) and
*"Scorer 143 reason, repeated across runs: 'required research skill … transcript shows … no
research-skill'"*. This is the self-improvement loop's terminal artifact: a code change to the
factory definition.

#### L. Automations — `wilson > Automations` (17:35)
Top-right **Manage Webhooks**, **New**. Same "Managed in GitHub" banner. Table:
**Automation | Trigger | Last run | Enabled** (toggle switch per row).

| Automation | Trigger | Last run |
|---|---|---|
| daily-factory-self-triage-report | Daily at 10:00 AM | 2 hours ago |
| github-pr-closed-or-merged | GitHub: PR closed, GitHub: PR merged | 2 days ago |
| linear-warp-mention | Linear: Issue assigned / Issue created / Agent session created | 2 days ago |
| slack-dms | Slack: Direct message received | 4 hours ago |
| slack-mention-github-warpy-factory | GitHub: Issue created, Slack: App mentioned | 16 mins ago |
| feedback-factory-digest | Daily at 8:00 AM | 4 hours ago |
| github-factory-mention-assign | GitHub: Issue assigned / mentioned, PR assigned / mentioned | 1 month ago |
| daily-factory-usage-digest | Daily at 10:00 AM | 2 hours ago |
| github-factory-auto-implement | GitHub: Issue labeled | 1 month ago |

#### M. Benchmarks — `wilson > Benchmarks` (18:15 → 19:00)
Toolbar 🔍 / filter / **New**. Rows: name + agent-type chip + age.
Seen: `Triage Default Model Selection` (Triage agent), `Foreman Default Model Selection`
(Foreman), `warp-bench-smoke-test`, `warp-bench-1.0`, `warp-bench-1.0-mini`,
`REV-2396 — Team settings action (Triage)`, `WarpBench 0.2`, `UI Computer-Use Implement`,
`Mini WarpBench 0.1`, `WarpBench 0.1`, `Full stack implementation agent`,
`Evelyn Testing - Triage / Implementation / Foreman`, `Simple Server UI Changes`,
`Simple Client UI Changes`, `WarpBench`, `Warp Server UI Implement Agent Benchmarks`,
`Factory UI Implement Agent Benchmarks`. Naming pattern: per-agent-type model-selection
benchmarks, per-surface UI benchmarks, and per-ticket replays (`REV-2396`).

#### N. New benchmark run (modal, 19:35)
Rows of **Harness | Model | Runner** triples:
`Warp (default) / auto / implementation (default)`, `Claude Code / fable / implementation`,
`Pi / fable 5.1 / implementation`, trash icon per row, **＋ Add configuration**.
Below: **Harness credentials** — "Configurations on the same harness share one credential."
`Claude Code → Select…` ("Used by 1 configuration." / "Choose how Claude Code authenticates."),
`Pi → Select…`. Footer: **Cancel**, **Run benchmark** (disabled until credentials are set).

This is the multi-model + multi-harness claim made concrete: one run can pit Claude Code and Pi
(and Warp) against the same task set.

#### O. Benchmark detail — `wilson > Benchmarks > WarpBench 0.1 > 9/2 at 10:45 PM` (20:05)
Top-right **Debug ▾**, **▶ Run**, ⋮. Right rail: **Most efficient → glm 5.3 flash, Overall 0.93**;
**Lowest cost option → glm 5.3 flash, $1.99/trial**.
Chart: **Correctness** (y) vs **Average cost** (x), both dropdowns. Points:
`gpt-5.6-sol (high)` ~95.2% at ~$6, `grok 4.6 (high)` ~93.2%, `glm 5.3 flash` ~93.2% at ~$2,
`claude opus 5 (high)` ~91.5% at ~$15, `gemini 3.7 flash` ~89.2%.
Warning banner: "Some plotted scores are based on incomplete scorer results. Use Rescore missing
scores in the three-dot menu next to Run to retry unscored tasks." Chips: `grok 4.6 (high) 28/29
tasks scored`, `glm 5.3 flash 28/29 tasks scored`.

#### P. Closing slides (24:39 and 25:15)
- Slide 19: **"The world is moving to factories. Factories should be open, adaptable, and defined
  in code."** → 1 Sandbox your agents · 2 Own your data · 3 Measurement beats vibes.
- Slide 18: **THE FACTORIES STACK** — 00 Factories-as-code (`FactoryYaml`, Agent Definitions,
  Automation Definitions, Launch Con…); 01 Data & Context (Runs + transcripts / Agent traces,
  Agent memory / Vector store, Agent artifacts / PRs reports attachments, MCPs / Internal
  knowledge); 02 Compute (Sandbox: Docker image · Kubernetes · Any remote env; Agent runner:
  Mac/Linux/Windows · configurable disk/ram/cpu; Computer Use: Video/image); 03 Inference
  (Warp-hosted inference: multi-model frontier + open-weight; Bring your own inference:
  Bedrock · Vertex; Custom model routing: LLM routing rules, self-improving); 04 Improvement
  (Metrics: Autonomy · cost · cycle time; Scorers: Evaluate completed runs; Benchmarks: Compare
  models/skills per task set; Self-improvement: Automatic observer loop); 05 Orchestration
  (Native Orchestration: Triage/Spec/Impl/Review/Verify; Multi-agent: Warp · Claude Code · Codex;
  Human in the loop: Live steering + handoff; Automations: trigger/cron); 06 Access (VIA Factory
  MCP: Any coding agent; Comms Platform: Slack · Teams; Task Tracker: Jira · Linear; Code Forge:
  GitHub · GitLab; Any Device: Web/mobile; Programmatic: API/SDK). Left gutter: "Warp hosted or
  customer hosted" spanning 02–03.

### 4.3 Screens that are referenced but never shown
`Inbox`, `MCPs and apps`, `Secrets`, `Users`, `Factory definition`, `Settings`, the agent
`Automations` tab, the dashboard `Spending` tab, and the `Needs review` / `Approved`
self-improvement tabs. Anything said about them would be invention — the nav labels and the
"Managed in GitHub / read-only" banner are the only evidence.

## 5. What to copy vs what to improve

### Copy
1. **Factory definition in git, UI read-only.** The "Managed in GitHub — configuration is
   read-only here" banner is the single best idea in the product. It forces definitions to be
   reviewable, diffable, revertible, and — critically — editable by agents via PR.
2. **One orchestrator agent holding all shared config** (MCPs, secrets, harness, model, runner),
   with thin per-stage sub-agents. One place to change the model, one place to rotate secrets.
3. **Per-run cost surfaced where humans already are.** The Slack replies carry `$6.50`,
   `$7.26`, `$8.62` inline. Cost visibility at the point of decision, not in a monthly report.
4. **Scorers as weighted classifications + threshold + sample rate.** Not a boolean "was it
   good": a rubric with numeric weights, a pass cut-off, and a sampling budget so evals stay
   affordable. All three parameters are user-editable per scorer.
5. **Self-improvement ends in a PR against the factory definition**, with evidence (run IDs,
   failure counts, scorer reasons) in the body. Human merge = the gate.
6. **Benchmark replay from stored sessions**, with a correctness-vs-cost scatter and a
   "most efficient / lowest cost" summary. Model routing falls out of the Pareto frontier.
7. **Automations table with trigger + last-run + enabled** — the operational view of "what wakes
   the factory up", and the recommended starting point for a new factory.
8. **The four metrics**: human interactions/PR, kickoff→merge, PR→first human review, cost/PR —
   plus slicing by source/agent/model.

### Improve
1. **The nav hides the most important page.** `Factory definition` is buried in a per-factory
   list and never opened in the demo. For a code-defined system, the definition should be a
   first-class, always-visible object (diff view, version history, "what changed since last
   week"), not a settings sibling.
2. **No visible rollback/canary story.** Zach claims versioning enables "testing and rolling
   back", but the UI shows no A/B factory versions, no staged rollout, no "run 10% of work on
   v2". Benchmarks compare models, not factory versions — that is the gap.
3. **Human gates are implicit.** The stack slide says "human gates and determinism", but no
   screen shows a gate policy (which stages require approval, who approves, SLA). In the demo
   the human gate is "merge the PR" and "approve in Slack" — ad hoc.
4. **Scorer quality is unaudited.** A 95% pass rate on an LLM-judge is only as good as the
   judge. There is no visible judge-vs-human agreement metric, no golden set, no drift alarm.
   Add calibration before trusting self-improvement.
5. **Self-improvement volume is a firehose.** 33 open items, 9 visible in the first screen,
   ages up to 18 days. Needs dedupe/clustering by root cause and an impact score (failed runs ×
   cost) so humans review the top 3, not the top 30.
6. **Cost per PR is aggregate-only.** The $55→$15 number is impressive but unattributed. A
   per-stage cost breakdown (triage vs spec vs implement vs review vs verify) would tell you
   *where* to optimize; the foreman prompt already encodes the cost hierarchy, the dashboard
   doesn't show it.
7. **Replay side effects are unsolved** ("you have to be thoughtful about how you do this").
   A real system needs hermetic sandboxes, recorded tool responses, and a diff of side effects —
   otherwise benchmark numbers are not comparable across runs.
8. **Everything is Warp-shaped.** "Harness: Warp", "Model: gpt-6.1-sol", GitHub/Slack/Linear
   connectors. The talk argues for openness; the product's defaults are the opposite. If you're
   building your own, invert this: make the adapter interface the first thing you write, and keep
   the default factory empty rather than "stock".
