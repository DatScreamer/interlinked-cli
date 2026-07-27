# Transcript — "From Agent Traces to Agent Simulations" (Rustem Feyzkhanov, Snorkel AI)

- **Source:** https://www.youtube.com/watch?v=Ib5t2RLtxvM (AI Engineer conference, 20:23)
- **Method:** whisper.cpp `large-v3` (`-mc 0` — first pass hit the known
  repetition-collapse hallucination at ~min 12 and was discarded), corrected by
  hand against a second whisper pass and YouTube auto-captions. Bracketed words
  are editorial corrections/uncertain hearings; filler ("uh", "like") lightly
  trimmed. A leading subtitle-credit hallucination over the intro music was
  removed. Intake: `snorkel-agent-simulations.md`.

---

Thanks, everyone, for coming. I know this is the last session before lunch, so
thanks for staying here — let's make it smooth and with good vibes, just as
[the host] said. And thanks [to the host] for the introduction and for inviting
me.

My name is Rustem, I'm leading the AI platform team at Snorkel. Today I want to
tell you how to turn agent traces into agent simulations, and why this becomes
the next stage for agent evaluations.

Three main things I want you to take away from my talk: every company needs a
benchmark — it's the only way to reliably evaluate, release, and improve your
agents. It has to be as close to production as possible — it has to mimic your
real tools, real API services, policies, and workflows. And finally, it has to
be part of your agentic lifecycle: it's not a static benchmark, it's a
constantly populated dataset from your production traces.

So why is Snorkel AI giving this talk? We are a data-as-a-service company, and
we're basically selling benchmarks — and producing benchmarks at scale. For us,
benchmark construction is an engineering discipline. We run millions of agent
simulations per month, and we've learned how to do environment build at scale,
using both agents and subject-matter experts to build reliable benchmarks that
are close to production in specific domains.

A lot of the time when people talk about agent evaluation, they're focused on
traces. And traces are very useful. The usual trace — you can see an example on
the screen — basically shows: here is the input prompt, here are the actions
the agent took, and here is the agent output. Then evaluation can analyze it
and say: was the agent successful or not? Was there an edge case? So it is
useful for finding failures in production, but it's hard to test different
variants. You can run A/B testing — that's one way of checking different agent
configurations — but it's hard to make sure everything is repeatable, because
you will get different database state, different tool versions, and so on. You
never fully compare apples to apples.

**Offline simulation turns traces into repeatable experiments.** You take
production traces, you construct tasks, and then you can run a simulation
benchmark with different agent configurations offline. You can compare agents
using different metrics — not just success rate, but cost, latency, and
retries. And you can run those in parallel.

You might ask: why do we need it — we already have public benchmarks? The
challenge with public benchmarks is that they're focused on very specific
domains. SWE-bench is focused on fixing GitHub issues; Terminal-Bench focuses
on an agent running in a terminal; [CUA-Bench] focuses on computer-use agents.
You want your benchmark focused on your company's domain — both in terms of use
cases and in terms of the tooling your agent has, whether it follows the
policies your company uses, and whether you get the full production
environment. **Public benchmarks are useful to orient and build your prior;
your private benchmark is useful to ship.**

Public benchmarks are also specifically focused on pass rate. Every time you
see a new model release you see pass rates on different benchmarks — which
makes sense, because it tells us about the frontier, how good the new model is.
But when you release an agent to production you care about more metrics: cost
of solving the task, latency, number of retries. By running evaluation offline
in simulations you can effectively compare apples to apples and iterate on the
agent. You can test the **full stack** of your agent — not just checking
whether one model performs better than another. You can check thinking
[tokens] — thinking level; you can change the prompt; you can tune the full
harness and the skills and tools available to the agent. Because in production
you don't care about the model — you care about the full system. Here you can
configure and test the full system while keeping the environment and evaluators
the same between runs.

That raises the point of what a benchmark *is* in this case. First, you can use
it to release the agent: make sure it works, handle edge cases well, select the
optimal model, debug the traces. Next, you can make it right: put it as a
release gate for your agent and verify that a change to the agent stack didn't
[introduce a] regression, and iterate on the harness. And finally you can
optimize: tune for better cost or latency — or use the traces to even do [RL]
training. Later I'll share a link to our website where we have an example of
how we used simulation environments to fine-tune a small [Qwen] model to match
the performance of a large [Qwen] model on specific tasks. Effectively it
becomes a trifecta of use cases: the benchmark becomes part of agent
evaluation, part of the integration test for agent release, and also a training
set for improving the agent.

So how can you actually construct it at scale? What is the anatomy of a
benchmark task? Step back: what is the sequence of running the benchmark? It's
straightforward. The agent gets an input prompt; it interacts with the
environment trying to solve the task — with APIs, MCP tools, database, files;
it produces the output: a trace, the final state of the environment, and
artifacts (basically output files). Then we run verifiers and produce the
metrics: was the agent able to solve the task, how well did it do, and so on.

The important second part of the task is the **Oracle**. The Oracle solution
runs through the full sequence, but instead of the real agent, it runs the
Oracle — and we construct the Oracle ourselves to make sure the task is
solvable in the first place. Because if it's not solvable, the agent won't be
able to solve it. So the Oracle is an important part of the task.

Looking at the anatomy in terms of files, take one of the most popular formats
nowadays — the **Harbor format**, made by the same team that maintains
Terminal-Bench. It's basically three sets of files: what the agent sees and
interacts with — `instruction.md`, a classic markdown file, and the
environment: a Dockerfile, or Docker Compose if you have multiple containers;
what the agent doesn't see — the Oracle solution and the verifiers; and
finally, some metadata. It may look very straightforward — "a simulation
environment is just a Dockerfile and a bunch of stuff" — but it's useful
because now you have a repeatable way of running experiments in agent
simulation.

Let's dive deeper into the two main parts of the benchmark. First, the
**environment**. The main challenge is that it effectively has to be
mini-production — but you don't want to run full production for every
experiment. You want your database, API services, tools, and files to match
production. As the previous speaker mentioned, you don't want your agent to
know it's running in a simulation — it has to be real. One thing, though: you
cannot put a real user in your simulation task, so you **simulate the user** —
effectively an LLM with its own prompt and additional context that can mimic
human behavior and interaction with your system. [The important piece is] that
all these things exist *in* the environment, and verifiers just interact with
the environment afterwards.

There are patterns for organizing the environment this way — think of it as
how you construct integration tests. You don't run the full production
database; you have a snapshot. You can run containers as [sidecars]: your
agent runs in one main environment, and other containers hold the API
services, databases, MCP tools available to it. You don't need full production
API services — you can mock them. I already mentioned simulated users. And one
important piece is **multi-step**: to handle long-horizon tasks that span
hours, you want intermediate steps — for each step a separate prompt and
separate verifiers — and you can finish a simulation early if you see the
agent failing. That enables simulating long-running-horizon tasks.

Next part: **verifiers**. In the traditional sense you just verify the output:
you get agent output, you verify it, that's it — that's how coding works, we
just verify the output code, we test it, and so on. Here it's more complex.
From the way the agent interacts with the simulation we get a lot of different
data. We get the world — how the environment changed, the final environment
state: what is your database state? What are the API responses? What were the
user replies? Your verifier analyzes **final state, trace, and artifacts**.

How can you analyze it? There are multiple ways. You can have **deterministic
checks** — that works really well for things like final output or tool calls,
where it's easy to check whether it was correct. Sometimes you can use **LLM
as a judge** — or even harness-as-a-judge or agent-as-a-judge — to evaluate
whether the trace quality was good, whether the agent's planning was correct,
and so on; it depends on the use case, so use one or the other or both. And
finally, you can use a **subject-matter expert** to review some of the traces
and outputs — not everything, but the cases where you see discrepancy in agent
behavior and want human involvement.

Final piece: how do we organize everything as part of the agent release and
improvement process? Can we just start? Not just yet — can something go wrong
with a benchmark task? A hundred percent. The agent can try to **reward-hack**
the simulation environment — it can understand it's in a simulation and hack
it. The task could be too simple, or the verifiers too broad — the agent will
always pass even when it does something incorrectly. The agent could always
fail because the verifiers are incorrect. Or agents may not perform stably and
you get high variation in success. All of these are edge cases you need to
catch during benchmark development — because benchmark development is an art
of its own. We've seen hundreds of benchmarks appear over the last years, but
this is a culture and engineering discipline that needs to be built in each
team shipping AI agents to production.

Because, as you saw — **the benchmark is software. It's code. It's files. You
need to treat it as such. You need a separate CI pipeline for it.** You can
check obvious things: all dependencies pinned, the base image correct, no
missing fixtures. Then you can run the Oracle solution and make sure it
passes — and that without the Oracle, the verifiers fail. You can run several
agent runs on the task and verify it is solvable *and* hard for the agent; you
can tag the task simple/medium/hard depending on how many times the agent
succeeds. And finally you approve it into your benchmark.

Then the process for improving the agent becomes straightforward: establish a
baseline on your benchmark; run the evaluation dataset; see the failures;
change **one thing**; rerun the experiment — you can use something like
[Arize] to record your experiments; once fixed, rerun the full experimentation;
then finally release to production.

What this unlocks is fixing issues *correctly*. There's an anti-pattern in the
industry where folks fix everything in the prompt — populating it with "never
do this", "only do that", "never output this". That's one way of handling it,
but with simulation you control the full stack, you can evaluate the full
stack, and you can make sure **the fix lives in the correct place**: you fix
the harness if you have context overload; if there's a missing procedure you
put it into a skill; if you need a specific output schema you make it
structured output.

Once the agent is in production you effectively have **two loops**. One loop
for benchmark expansion: you take traces from observability (using something
like [Arize]), record failures, and use the failures to build your benchmark
further. Then you have a simulation runner that runs experiments on the
extended benchmark or on a new agent config and records those experiments; you
use it as a release gate — does the agent perform significantly well — and
finally release to production. It's important that your observability piece
and your experimentation piece are connected, because they're two sides of the
same coin.

To summarize: every company needs a benchmark. Traces are useful for finding
edge cases in production, but simulation lets you test *what would happen*.
And you want your benchmark to be part of your agent-ops loop. Thank you very
much for your time — I'll be happy to answer questions outside, and please
check our booth if you have questions about benchmarks.

## Q&A

**Q: Great talk. About structuring the benchmark — how many examples should
you include, ideally? Do you split them into a train/test split, and if so,
how do you recommend structuring examples across the two splits?**

A: Great question — how to structure the benchmark for training and
validation. As previous speakers shared, they also had the pattern of a
train/validation split. This is very close to traditional machine learning:
you want a standalone dataset the agent didn't see, where you can verify the
agent config. The classic approach applies — 80/20 — it always depends on the
use case, but you do want a held-out dataset the agent didn't see during the
experimentation process.

**Q: When you create the benchmarks, what data do you include? Handpicked
production runs? If your agent isn't in production yet, do you create
problems for it? And if you're handpicking, how do you ensure coverage
similar to production?**

A: Coverage and distribution of the benchmark is a very important piece. You
want both: bread-and-butter use cases covering the main use cases that work,
but also edge cases — making sure your agent can handle a tool failing, a
problem with the database, and so on. Think of it as integration tests: you
have the happy path, but you also have edge cases.

**Q: Would you simulate [users] with LLMs or create handcrafted [ones]?**

A: Simulate versus handcrafting — people use agents to write code, so a lot of
this can be automated; what counts as "handcrafted" is changing. The most
important piece you provide is building the environment once, and then the
context that mimics your production.

**Q: You mentioned sometimes LLMs and sometimes human experts build the
verifiers. What's the best practice?**

A: In our case we have a lot of subject-matter experts, so we do things at
scale. The important piece: you don't need subject-matter experts to review
everything — you specifically want the cases where there's **disagreement
between the agent and the verifiers**: the task was supposed to be solved but
the agent marks it as not solved correctly, or marks the trace as not optimal.
That's where you want a subject-matter expert who can tune the agent that does
the review.
