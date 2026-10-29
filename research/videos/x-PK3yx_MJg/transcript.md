# What it takes to build a software factory

- Channel: Warp
- Duration: 0:25:51
- Source: https://www.youtube.com/watch?v=x-PK3yx_MJg
- Caption source: manual

[00:00] Hey, I'm Zach, the founder of Warp. I wanted to record a version of a talk I've been giving
[00:06] about how I think about software factories and how we at Warp think about them. I want to cover what a software factory is, in my opinion. What are the most important
[00:20] characteristics of it? We think of it as infrastructure. What does a working software factory look like? I'm going to illustrate a lot of this with a real product:
[00:30] I'll show some of Warp Factories. But I think the same concepts apply if you're building your own software factory from scratch, which a lot of folks are trying to do.
[00:42] About me: I was a principal engineer at Google. I used to run engineering on the Google Docs suite.
[00:48] I've been a software developer for a really long time. I'm the founder and CEO of Warp.

[00:54] If you're not familiar, we're a company in the agentic development space. Our mission has
[00:59] always been to help developers ship better software more quickly. Our total focus right now is on
[01:06] software factories. We have a platform called Warp Factories, which is open infrastructure for
[01:12] companies that want to build their own internal software factories. But we're also pretty well
[01:17] known for the Warp terminal, an agentic terminal with about 65,000 GitHub stars. We have almost
[01:22] a million developers who actively use it. It's a super cool product. But today I'm going to talk
[01:28] about software factories. The way I usually tee this up is: this is the journey of agentic development. If you look back a couple of years, we were using things like

[01:41] Cursor autocomplete, which was really cool. About a year ago, we collectively moved into a mode where
[01:48] every developer installs Claude Code or Codex on their laptop and prompts to build features. But
[01:56] they're basically working locally, creating a PR, and then pushing it up into the system. What I
[02:03] think we're going to get to, from talking to a lot of companies and from how we're working more
[02:07] and more internally at Warp, is a world of much more automated development. The reason for this,
[02:13] from a business perspective, is that there's this magical new technology. It's really incredible.
[02:20] Everyone wants to get the most out of it, and we're all learning together.
[02:26] What does that mean? How do we deploy agents to get maximum business value, to ship stuff that's

[02:31] really useful for customers, and make sure it's not sloppy and the quality isn't bad? We all
[02:38] want to do this, and there's going to be a better way to do it than what everyone is doing right now. If you drill one level deeper, the problems the world
[02:49] has with these interactive agents are, first, you're totally bottlenecked by people. And this
[02:53] is software that you want to let loose to do more. You want more automation if you want more
[02:58] productivity. Interactive agents also have all sorts of problems with cost management.
[03:05] They're very hard to collectively optimize because everyone's doing their own thing. And the third thing is there's no central layer for governing them, so there are
[03:13] all sorts of security problems. To double-click on security for one second: when everyone is using local agents, everyone's setting up their own MCPs. If something

[03:24] gets compromised, it's compromised as the logged-in user. They're hard to govern. The solution here is generally going to be to sandbox them. What I want to talk about is
[03:35] what a cloud software factory is. If you follow Twitter, there are a lot of different
[03:41] versions of what this might mean. To me, it means something very specific. It's an agentic loop
[03:48] where humans and agents collaborate. It runs in the cloud. You can't have a local software factory
[03:55] because you can't have automations running off your laptops. And the really key thing is that
[04:01] it's a measurable, improvable system that you can do what I call factory engineering on, so that you
[04:09] can actually make the system better over time. I'll talk about that more in a second. But

[04:14] the basic way one of these software factories works is that ideas come in from various sources. It could
[04:20] be directly from a person. Then agents do some amount of work, whether it's triage or
[04:27] spec. They might loop a human in to work on a spec together. Agents implement, they do code review,
[04:35] they might loop a human in for code review, they do computer-use verification and QA, they go
[04:41] through CI/CD to ship, and then they do some amount of monitoring. This loop is going to look different
[04:47] in its details at every company, on every team. So this isn't meant to be one-size-fits-all. But
[04:54] a software factory should support building different variants of this loop. It could
[05:01] be for the software lifecycle or for the broader product lifecycle. But this is what you

[05:06] want. This is how you should conceive of it, in my opinion. I also feel really strongly that the
[05:12] right way to view software factories is as infrastructure, and that infrastructure should be as flexible as GCP or AWS. Specifically,
[05:24] that infrastructure should be open, meaning you should be able to put in any model, any harness, and use
[05:31] it in your factory. It should be very composable, pluggable, and really adaptable.
[05:37] The only way the software factory approach is going to work for companies at any kind of
[05:41] scale is if you can set it up to work with your existing tools and systems. And this really
[05:48] big thing is what makes the whole thing real to me: software factories should be defined
[05:53] in code. You should declare what your software factory actually is. You should say, "These are all

[05:59] my agents and MCPs, these are the repos they operate on, these are the skills they use." And it should be
[06:05] versioned. Once you do this, it creates opportunities: how do you test different versions of a factory? How do you let agents self-improve a factory? This is the
[06:18] key thing. It's got to be a real declarative system. I also think AI sovereignty really matters. What
[06:25] I mean by this is, if you're building one of these factories, you should really try to keep
[06:30] all the data going through it on your own systems. That data is what you're going to use to improve your agents, and you don't want someone else having it.
[06:43] If you view producing software as a core part of your business going forward, having that data in

[06:48] your own system matters. It should be flexible enough to run on your own compute. You might want
[06:53] to run your own models. It should be able to run with your own inference gateway, and it should be able
[06:57] to use any model in any harness. So I think open is going to win here, as opposed to a walled
[07:03] garden, single-vendor solution. Okay, this is really important when I think about software factories.
[07:11] If you look at Twitter, which I do too much, on any given day you might have the sense that there's a new best harness or a new best model. It's hard to tell who has a
[07:25] conflict of interest when they're talking about things. The solution is to get a system in
[07:30] place where you can measure how coding agents are doing on your own workflows. That means

[07:37] having LLM-as-a-judge evals on all your coding agent sessions, using those evals to drive a
[07:43] self-improvement loop, and being able to benchmark different configurations. So you can actually,
[07:48] instead of using SWE-bench or Terminal-Bench, prove to yourself that you have the right setup.
[07:55] As for what this all means for engineers, I think it matters a lot. The way I
[08:00] conceive of it, there are going to be two kinds of engineering going forward. There's product
[08:05] engineering, which is still going to matter. You're building something of value for some
[08:10] customer or user. But product engineering is going to happen through a factory, meaning work is going to
[08:16] go into this closed-loop system, and humans are going to have touch points with it. Then there's factory

[08:23] engineering, and I'm very excited about factory engineering. This is the job of taking
[08:28] your software factory and making it more efficient. It's really a lot of performance
[08:34] tuning: figuring out what skills and MCPs, what model mix, and what workflow are right, so that
[08:41] your whole team doing product engineering can do it better. Instead of just doing slides, I'm going to show this in the context of Warp Factories, which I'd
[08:53] encourage folks to go try, obviously. But I think these same things apply as you think
[08:59] about factories more broadly. So let me bring up Warp Factories to illustrate some of these
[09:03] concepts. I mentioned earlier that there's a job of product engineering and a job of factory
[09:09] engineering. This view is what the factory engineer is going to use. It's a view of your whole

[09:17] system. The way this works in Warp Factories is you have one factory per product surface.
[09:23] The way to think about that factory is as a collection of agents, and this collection of agents is defined in code. I'll go back to this
[09:38] for one second. We provide a default implementation where all work that comes into the factory goes through what we call a foreman agent. If you look at this foreman
[09:49] agent, it has all of the centralized configuration: what MCPs does it need? What are the secrets? What model does it use? Where does it run? You can see what automations
[10:02] it can be triggered by. And you can see the prompt for this foreman agent. When work comes in, it delegates it to other
[10:12] agents using an orchestration pattern. The actual details of this aren't too important.

[10:16] This is our stock factory, but you can think of it as going through that loop. You do triage, specs, implementation, and code review. The way you interact with
[10:27] this foreman, and I think this is really important, is that you can do it from any surface. If you're setting up a factory, we do support talking to your factory here,
[10:40] but this isn't how we expect folks to interact with factories. I think you should be thinking about factories by integrating them into your existing tool set.
[10:52] For instance, at Warp, the tool we primarily use at this point is Slack. But we have customers who use Teams, Linear, Jira, and GitHub. It doesn't matter
[11:07] where you interact, because all of the context for your factory needs to be in the cloud, in one

[11:12] central place. For instance, here you can start, and this looks a lot like starting with
[11:18] a prompt to a local agent, honestly. This is Varun on our team asking for some changes.
[11:24] It goes through a flow, and work goes to the foreman. What's different from just using a regular coding agent is that along the way,
[11:36] it goes through the triage step and all the steps we define in the actual workflow. Everyone is working this way. And you can
[11:47] see you get these cool benefits. Here, it's created the Linear issue. I could interact with this in Linear if I wanted. In the same way, it's created
[11:58] the server PR, and it's done computer use, so it's proven that it's done the right thing. Anyhow, the point is, as a product engineer, you're working through the tools

[12:14] you already use. We use Slack; you could use Linear or GitHub. You could even use a local coding agent and submit work into the factory through it. In many ways, this is
[12:25] the least interesting part of the factory approach. The more interesting part is that when you start working this way, not only do you define your factory
[12:37] workflow in code, but you also get the ability to see in real time what everyone on your
[12:44] team is doing across all the factories you're working on. Think of this almost like Google Docs,
[12:51] but for your team's coding agents. I can see Ben on our team is working on this
[12:58] diagnostics cloud agent run. I can go in and see it. I could go back and see the original Slack
[13:03] thread where this happened. The cool thing is that it's all centralized. When you centralize it, not only do you

[13:09] get this real-time view, but you get automatic storage and tracking of everything
[13:17] people on your team are doing with coding agents. Once you have that, you can actually start doing factory engineering. To me, one aspect of factory engineering is
[13:29] understanding the flow of work through your factory. This is the stuff you should be looking at today if you're doing factory engineering:
[13:40] How many human interactions are there per PR? How automated are you? How long does it take to ship? How much money are you spending per PR? Slicing that by different
[13:55] sources, by user, by agent, by model. Calculating and knowing your cost per PR,
[14:03] and having a plan in place to drive it down. Then, one level deeper, what I mentioned earlier: the ability to do online evals, or what we call scoring in Warp Factories,

[14:18] on top of all your existing coding agent runs. What do I mean by scoring? Once you're in a world where, just to remind you, all of your coding agent runs are stored,
[14:28] you get the ability to run LLM-as-a-judge over them to evaluate them along different dimensions. One of the dimensions we look at at Warp is redundant
[14:41] tests. This is just an example; you can define your own. With redundant tests, there's a common failure mode where coding agents
[14:50] waste a bunch of money, time, and context writing unnecessary tests. So we have agents look at our past agent runs using LLM-as-a-judge to figure out where we're
[15:03] experiencing this failure mode. We don't do this on every run because it's kind of expensive, but there's a sampling strategy and pass/fail criteria. And all of this,

[15:16] again, is defined in code, this whole scoring mechanism. So you can see how you're trending.
[15:23] The next thing you can do once you have this type of system in place is set up another loop, which we call self-improvement, where agents look at these failed runs
[15:38] and try to suggest changes to improve the underlying factory. I think this concept is really important. We're getting more and more sophisticated in terms of
[15:48] how we do this and how we prove that it actually works. But the general idea is we have agents looking at all of these scores. They find repeated
[16:02] problems. Here's one that was identified as a problem with our triage agent. We saw this 54 times.
[16:08] Then they suggest improvements to the definition of the factory itself to fix the problem. For instance, this is a change to our factory

[16:26] code format. This is why it's so important to define everything in code: you have coding agents observing problems in how your company is producing
[16:38] software. They observe it on a repeated basis. They're smart. They say, "Okay, the actual underlying
[16:46] problem is with the way the factory itself is specified, and we can suggest a fix." Then they make a PR that we can merge into the factory definition, so this problem
[17:00] doesn't occur again. This is what we call self-improvement. No matter how you approach this, it's a very useful primitive for getting to a loop
[17:13] where your factory actually gets better over time. A couple more things I want to show: I've mentioned how you put work into the factory as a person.

[17:24] The goal is to have a similar flow for work coming in through automation triggers. If you're building a factory, this might even be where you start.
[17:36] You should have a way of saying, in addition to a direct human prompt, we want an automated prompt or trigger that puts work through this
[17:49] exact same factory workflow, or a slightly different one. So your factory should support a set of automations. One more thing I want to touch on, which comes
[18:01] back to measuring and improving everything, is that you want to be able to truly measure how coding tasks perform with different models and different factory
[18:17] configurations on your own real workflows. The way we think about this at Warp, and what we've built in, is the concept of a benchmark suite. Basically, that means

[18:33] for anything being done within a Warp factory, you have the ability to say, "This is an interesting task." Maybe it's a hard task, or a specific class of
[18:45] task, like a frontend engineering task. You can add it to a benchmark. What ends up happening is you build up benchmark suites, and with these benchmark suites,
[18:59] because you're tracking all of your coding agent sessions, you have the ability to rerun and replay them. You have to be thoughtful about how you do this with side
[19:13] effects and so on, but we've built a lot of infrastructure where you can say, "I want to test how things perform against different model configurations."
[19:27] You can test against different harness configurations. I could see how it does in Pi. I could choose the model. When you do this, it runs a matrix of tests

[19:40] against your own real coding agent tasks, and then produces something that looks like what you get
[19:49] with one of the public benchmarks. I think this concept is extremely powerful, and everyone should be thinking about how to get to it. It generates a
[20:03] correctness-versus-cost trade-off curve. You can use different scoring dimensions here, but for this particular benchmark, the way to read it is
[20:15] the further up and to the left, the better, because left is cheaper and up is higher quality. You can see the two candidate models
[20:26] for winning this benchmark, along this Pareto curve, are GPT-5.6 Sol. We ran this one a while ago. It cost $6.23 on average but got 95% correct. And GLM-5.3
[20:41] Flash, which was a third of the cost and just a little less correct. This isn't saying that GPT-5.6 Sol is better than GLM-5.3 Flash or vice versa in every situation.

[20:54] It's saying that for these types of tasks, you can make an educated trade-off on whether
[21:01] you prefer slightly higher quality at three times the cost. I'd say we would probably choose GLM-5.3 Flash for this, honestly. Then you can feed this into a model routing
[21:14] strategy that applies to similar tasks. Again, the idea is that instead of relying on Terminal-Bench or SWE-bench, which are cool and useful for general intelligence,
[21:27] for generally measuring a model, you say, "For our own work, what's best?" This is a very powerful primitive, especially when you
[21:38] combine it with the ability to do model routing off of this information. The way we tie this all
[21:43] together, and the way I think it's useful to tie it together, is by thinking of software

[21:49] factories as a stack. At the bottom of this stack is the definition of factories as code.
[22:01] Just to remind you, that unlocks versioning, testing, and rolling back all of the configuration for how your factories work, which really means how software development,
[22:14] agentic development, works at your company. The second piece above that is a data and context layer. You should think about all the data coming into the
[22:26] factory, from MCPs or from APIs, and all the data coming out of the factory. That could be agent runs and transcripts,
[22:37] which I'd say is the most important thing, but agents also produce things like screenshots and videos, and there's a memory concept. So all sorts of data comes out.
[22:45] The third layer to think about is compute: where do your agents run? As I mentioned earlier, you want them to run in sandboxes for security and governance reasons.

[22:55] Depending on requirements, you may want to support sandboxes across multiple platforms. Inference should be pluggable. I feel very strongly about this. Most companies we
[23:09] talk to want to bring their own inference. They want the ability to try different
[23:13] models: open-weight models, frontier models. They may want to try a fine-tuned model they've
[23:17] built. So having this be a pluggable layer is very important. Improvement primitives
[23:24] that let you close the loop and actually improve your factories: very important. Orchestration:
[23:31] I showed just a little of our orchestration primitives, but the way we think about this is: what steps or stages do you want your process to go through? How do you
[23:43] gate those with human gates and determinism, while also taking advantage of the fact

[23:50] that agents are intelligent and can do intelligent routing? Again, this should support multiple harnesses and multiple automation primitives. And finally, a really
[24:01] important primitive for building a factory is supporting all sorts of access points
[24:08] into the factory. The mental model is that work goes into the factory, and agents within the factory work on it. That work can come in via MCP, through Slack or Teams,
[24:19] through Jira, Linear, GitHub, or GitLab. You should be able to build your own UI on top of it. It should all be API-driven. To me, this is the system where, if you're
[24:31] thinking hard about what automated development looks like, you're going to want to end up with
[24:37] something that looks kind of like this stack. Obviously, I'm not unbiased here. We've built a lot of the primitives here, and the way we think about this is

[24:49] really about helping platform teams that are looking at this space accelerate getting to this world. You can definitely come check out Warp Factories if you're
[25:01] interested, but hopefully this has been useful for anyone asking: what are software factories? What do they really mean? How do you build one for real? We're spending
[25:11] a lot of time thinking about this, and we've had a lot of success. I usually have a slide in here about how we've lowered Warp's cost per PR from about $55 to around $15
[25:26] in the last six weeks, while increasing our PR throughput by about 40% and having a lower revert rate. So this isn't just putting out slop. I have high
[25:39] conviction that this approach works and that this is what the future of development is going to look like. All right, thanks for checking this out.
