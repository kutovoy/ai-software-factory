# Why Software Factories Fail

- Channel: AI Engineer
- Duration: 0:19:17
- Source: https://www.youtube.com/watch?v=Ib5GBkD555M
- Caption source: whisper:small.en

[00:29] Guys, give it up for all the great speakers today so far.
[00:36] All right, this is harness engineering is not enough,
[00:39] and why software factories fail.
[00:42] And we're going to click maybe.
[00:48] Oh, that's way too many slides.
[00:49] Hold on, guys.
[00:50] OK.
[00:52] So we're all racing to put AI coding into production.
[00:56] And there's been lots been said about loop engineering.
[00:59] And we should probably write more loops.
[01:02] And yeah, I guess we're doing loops now.
[01:07] Strong DM, built a lights off software factory
[01:09] where nobody even reads the code.
[01:11] And the prevailing narrative is we should just
[01:14] spend more tokens.
[01:16] You are the bottleneck.
[01:18] The models are good enough.
[01:19] Code is free.
[01:20] Just ship more stuff.
[01:22] But at the same time, we are starting to see the cracks.
[01:26] Our friend Mario at AI Engineer Europe

[01:28] begged us to slow down because companies that should not
[01:32] be having outages because of coding agents
[01:34] are having outages due to coding agent mishaps.
[01:37] Code bases are falling apart faster than they ever
[01:40] have before.
[01:41] And our friends at Faros AI actually even
[01:43] did a report since we all picked up all these AI coding
[01:46] tools in January, maybe February.
[01:50] Pull request, code review quality is way down.
[01:52] We're having more comments, longer comments,
[01:54] and tons of PRs being merged without any review at all.
[01:58] Incidents are way up.
[01:59] Bugs per developer are way up.
[02:01] And many people will tell you that you're holding it wrong.
[02:04] That's the only reason.
[02:06] You're not.
[02:08] Well, maybe you are.
[02:09] But that's not the point.
[02:12] I've spoken a lot about how to hold it better when

[02:14] it comes to working with AI, probably a million views
[02:17] on YouTube at this point across a bunch of different talks.
[02:20] And the basic thing is, as engineers,
[02:22] we've been told that if token maxing isn't working,
[02:25] then it's a skill issue.
[02:27] You just need to spend more tokens.
[02:29] Let go of reading the code.
[02:31] That with enough harness engineering,
[02:33] if we maybe sprinkle some magic words,
[02:36] adversarial review on enough of our PR bots,
[02:40] that we can get the best of both worlds.
[02:42] 10 to 100x faster, high quality, and nobody
[02:46] has to do that thing we all hate called code review.
[02:49] I'm here to convince you today that this is in fact not
[02:52] a skill issue, that no amount of harness engineering
[02:55] or loops maxing can solve what is fundamentally
[02:58] a model training issue.

[03:00] That's why we say the harness is not enough.
[03:03] And to understand this, we kind of have to grapple and dig
[03:06] into how coding models are trained.
[03:08] I'm going to talk about what I think
[03:10] the shortcomings are with some of the current benchmarks
[03:12] and what better ones might look like.
[03:14] And we'll talk about how to move faster safely
[03:16] in the meantime.
[03:18] It's going to sound like a rant, but there is hope here.
[03:20] I'm going to talk about our journey
[03:21] and a bunch of the landmines we've hit building
[03:23] in this world, a bunch of exciting new techniques
[03:25] that we've been working with a lot of our users
[03:27] and customers to develop.
[03:29] And I think how we all as a community
[03:31] get to the next chapter of agentic engineering
[03:34] after whatever this thing that we're in.

[03:36] So we use a lot of words here.
[03:37] I'm going to zoom out a little bit.
[03:38] I want to give you kind of like a brief history
[03:40] of the software factory.
[03:42] And actually, I just learned this last week.
[03:45] The term software factory was defined at a NATO conference
[03:48] in 1968.
[03:50] We're going to start around 2022, right before AI
[03:52] started coming around.
[03:54] And basically, in a typical 2022 software factory,
[03:58] you will have some people building stuff.
[04:00] You'll have engineers.
[04:01] You'll have PMs.
[04:02] Maybe you have some sort of leadership team
[04:03] that is driving the vision here.
[04:05] And they all decide that stuff needs to get done.
[04:07] And so you put it in a tracker, a linear, a JIRA, a Beads,
[04:11] some sort of state machine that tracks what needs to be done.
[04:14] And then someone goes and grabs something off of there,

[04:16] and they build the thing.
[04:17] And there may be some automated testing in that process,
[04:19] maybe some manual testing in that process.
[04:22] At a certain point, we make this pull request thing.
[04:24] It says, OK, cool.
[04:25] We've got to run a bunch of checks, automated stuff.
[04:27] A human's going to review the change and review the code.
[04:30] And perhaps we might even have a human pull it down
[04:33] and test it somehow.
[04:34] And if anything goes wrong here, we loop back
[04:36] to someone builds the thing.
[04:38] And eventually, we're ready for prod.
[04:40] And so we ship it to production.
[04:41] And once it's in prod, it makes contact with our users.
[04:45] And users do a thing that we all love.
[04:49] Users love to complain.
[04:51] I love our users.
[04:52] But yeah, they're going to ask for things.
[04:54] They're going to find bugs.

[04:55] They're going to file feature requests.
[04:57] And that goes back to your team.
[04:58] You might also add monitoring.
[05:00] And so what do we want more than anything else?
[05:03] We want to wake up engineers at 3 in the morning
[05:05] when something breaks.
[05:06] So they can get dragged out of bud to try to go fix it.
[05:09] And we go on and on in this loop.
[05:12] And we ship a bunch of code.
[05:14] And one thing that we noticed here
[05:15] is that teams figured this out decades ago,
[05:18] is that this someone builds the thing step
[05:21] is usually going to take hours or days in most cases.
[05:25] And the review part will also take hours or days
[05:28] for large things.
[05:29] And so teams started doing these upfront planning, architecture
[05:31] proposals, sprint planning.
[05:33] And it would collaborate on these things as a team

[05:36] with the hopes that we might decrease the percent chance
[05:39] that something would need to be reworked.
[05:41] That we would be able to reduce the time spent
[05:43] in reviewing every line of code
[05:45] because we aligned on everything ahead of time.
[05:48] This brings us to the agentic software factory.
[05:51] Every company and their mother is talking
[05:54] about how they built a coding agent factory that
[05:56] shifts 75% of their code now.
[05:59] Literally everybody.
[06:01] And so we look at a software factory from 2022.
[06:04] We just replaced someone builds the thing
[06:07] with an agent builds the thing.
[06:08] And we have an orchestration, and a harness, and a sandbox,
[06:10] and a model, and computer use.
[06:11] And I'm not going to get into the details of that.
[06:13] You can watch 100 talks about that this week, I'm sure.

[06:16] But now the building part takes minutes or hours.
[06:18] But this human part still takes hours or days
[06:20] if you're going to review the code
[06:22] and you're going to test the changes.
[06:24] So we bring an agentic code review.
[06:25] We bring in agentic regression testing.
[06:28] And it makes this part faster.
[06:29] But it's probably still the bottleneck.
[06:32] But we can do more loops here.
[06:33] Why not?
[06:34] Let's do some more loops.
[06:34] So we can route all incidents straight into the factory.
[06:37] Why does someone need to get woken up
[06:38] and try to fix it when they could just
[06:40] wake up to a pull request?
[06:41] And maybe that fixes the issue for you.
[06:44] You can take all the user feedback
[06:45] and just stick it straight into the factory
[06:47] so that people ask for stuff and it gets built.
[06:50] And now your only job is how much things

[06:53] can you stuff into the queue of stuff to do
[06:55] and how fast can you review and test the changes?
[06:58] Which brings us, of course, to I'm sure you know
[07:00] the lights off software factory.
[07:02] Where basically Dan Shapiro coined this is
[07:04] we no longer read the code.
[07:05] We say, you know what, this is going great.
[07:07] That code review thing, no thanks.
[07:10] We're just not going to do that anymore.
[07:12] And we invest into all these other parts of the system.
[07:15] You're testing, you're monitoring,
[07:16] you roll out everything else.
[07:17] We just write more code and build those systems better.
[07:20] And now our job really is just how much stuff
[07:22] can we ask the agent to build?
[07:25] I am going to posit that this does not work.
[07:29] And this is why software factories fail.
[07:31] As I decide, what I'm going to say

[07:33] has nothing to do with vibe coding.
[07:35] So Addy had this great post.
[07:37] I'm gonna just go literally take his quote verbatim.
[07:39] A developer vibe coding a side project
[07:41] a dozen people will ever run
[07:43] and a team keeping a 10 year old enterprise system alive
[07:46] for another quarter share almost no constraints
[07:49] worth naming.
[07:50] And most of what you hear on the internet
[07:52] is one of these groups of people
[07:53] telling the other group of people how to live their lives.
[07:56] So if you love vibe coding, please go on.
[08:00] At Human Layer what we care about
[08:01] is how do we help people solve hard problems
[08:03] in complex code bases.
[08:06] We use the word brownfield a lot
[08:07] which historically has meant like
[08:09] some 10 year old Java thing.
[08:11] I actually think agents really start to struggle

[08:13] after maybe three to six months
[08:14] especially with the pace at which we can ship now.
[08:17] You can ask me how I know this
[08:18] and I will tell you that it is because in July 2025
[08:21] we tried this, we went full lights off
[08:24] and if you have tried this seriously for a number of months
[08:27] you probably found at least one issue
[08:30] that the agent couldn't solve.
[08:32] Even with your most advanced prompting
[08:34] you do research, you do reproductions,
[08:36] you just, you have to go and dig into that code base
[08:39] that you stopped reading three months ago
[08:41] to try to figure out what's broken.
[08:43] And in the meantime your site was down,
[08:45] your users were pissed
[08:46] and if you were like me you were probably miserable
[08:48] reading all this slop code that you let slip
[08:50] into your system.

[08:52] And what I want to get to is basically
[08:54] models have a shortcoming.
[08:56] They can't maintain and improve code base quality over time
[08:59] not without a decent amount of human steering.
[09:02] And when I say maintainability
[09:03] I'm basically talking about issues like
[09:05] it becomes really really hard to make a change
[09:07] in one part of the code base
[09:09] without breaking other parts of the code base.
[09:10] This is Martin Fowler shotgun surgery textbook code smell.
[09:14] I'm not gonna say much more about maintainability
[09:15] there's a bunch of books that you can go read about it
[09:17] in fact John Osterhut is actually here speaking this week
[09:19] so you can go ask him in person
[09:21] about the philosophy of software design if you want to.
[09:24] But it brings us to this question of like

[09:25] why can't models do software maintainability?
[09:28] And you may also be saying
[09:30] but surely the models have gotten much better since then.
[09:33] They've gotten better in some ways
[09:35] but they're still about the same in others.
[09:37] If you want to solve one off problems
[09:39] or vibe code a new marketing site
[09:41] yes they got way better since 2025 and 2024.
[09:44] But as far as improving code base quality
[09:47] I think they have not gotten much better.
[09:49] Now I cannot prove this
[09:51] because there are no good benchmarks
[09:53] for a model's ability to maintain code base quality
[09:56] and I'll get into like where we're going with that.
[09:58] But if you've worked with coding agents for a while
[10:00] a lot of people are posting about this
[10:02] it's just like you probably have this vibe
[10:04] that they generally make things worse over time

[10:06] and make the code base harder to work in.
[10:08] And to figure out why this happens
[10:10] I'm gonna zoom out to the first great coding agent.
[10:13] Why did Cloud Code go from nothing to four billion
[10:17] and I think now they're at nine billion in revenue
[10:20] in under a year?
[10:22] Because they were great CLI agents before Cloud Code.
[10:24] You had Adir, you had CodeBuff,
[10:25] there was a bunch of tools in this category.
[10:27] They had all the same tools,
[10:29] read, write, edit, grab, bash.
[10:31] So what was the difference?
[10:32] The difference was that this was the first time
[10:35] that a model lab trained a model against the harness
[10:38] that they were gonna distribute it to users in.
[10:41] And it got really, really good
[10:42] and this is just some of the tools
[10:44] but it got really, really good
[10:45] at calling these sorts of tools in an agentic loop.

[10:48] In fact, the OpenAI team did a talk in November
[10:51] about basically if you are a harness builder
[10:56] and you don't own the model weights
[10:57] and you can't RL the model in your harness
[11:00] you will always be at a disadvantage
[11:01] compared to somebody who owns
[11:03] both the model and the harness.
[11:05] And I'm gonna cite a couple slides
[11:07] from my buddy Calvin French-Owen
[11:08] who was a MTS on codecs during the initial launch.
[11:12] But LMs are just next token predictors.
[11:14] This is a slide from over a year ago
[11:15] where basically as you're doing your agentic loop
[11:17] context window goes in, next step comes out.
[11:20] And we're gonna try to do this,
[11:21] I haven't actually timed this,
[11:22] but we're gonna see if we can do coding agent
[11:24] reinforcement learning in 60 seconds.
[11:26] So what we're gonna do if we wanna train a model

[11:28] to get better at tool calling,
[11:29] better at solving software problems,
[11:31] we're gonna generate a bunch of,
[11:32] we're gonna give it a problem
[11:33] and we're gonna generate a bunch of traces.
[11:34] Try to solve the problem a bunch of different times.
[11:36] We're gonna score them all on correctness
[11:38] and did the test pass and all this stuff.
[11:40] And then we're gonna reinforce.
[11:41] We're gonna make the bad behavior less likely
[11:44] and we're gonna update the weights
[11:45] to make the good behavior more likely.
[11:48] This is one of the classic ones here
[11:49] is suite bench multilingual.
[11:51] They're about 15 minute tasks.
[11:52] They're from open source repos like Redis,
[11:54] JQ and Django and all this stuff.
[11:56] And they have binary one or zero rewards
[11:58] on did you fix the problem you were trying to fix

[12:01] and did you do it without breaking anything else?
[12:03] And we look at actually a real problem
[12:04] from one of these benchmarks.
[12:05] This is Fastlane which is a Ruby project.
[12:08] Basically there was some issue
[12:09] where we weren't checking for nil
[12:10] and we have a stack trace blow up
[12:12] because you have a null pointer exception.
[12:13] And in this benchmark you have a base commit
[12:17] that we're gonna check out before the issue
[12:18] was solved by a human in the past.
[12:21] We're gonna give it a test patch
[12:23] that says here's what the behavior should be afterwards.
[12:26] We have a golden patch.
[12:27] Both of these are hidden from the model.
[12:29] And so we have the agent go try to solve the problem.
[12:31] We store its patch.
[12:32] We undo all the changes it made to any test files
[12:35] because I'm sure you've seen models comment out tests

[12:37] just to get things working.
[12:39] And then we're going to apply our golden test patch
[12:42] and then we're gonna run the test.
[12:43] Old test and did the new test pass.
[12:45] And if they both pass then we get the reward
[12:48] otherwise we don't.
[12:49] And so models are trying to get the test to pass.
[12:52] There's no way in this system
[12:53] that we can penalize it for poor program design
[12:55] or for eroding the maintainability of our systems.
[12:58] That's why we get things like this.
[12:59] Try catches around things that probably
[13:01] don't need a try catch.
[13:03] Or things like this.
[13:04] I think Bibob gave us this example earlier
[13:06] of casting things to other things
[13:07] just so the model can, it just wants to get the test to pass.
[13:11] And so if you can't verify the maintainability of the code
[13:14] it gets way harder to train on this stuff.

[13:17] So you remember this picture.
[13:19] Verifying code quality and maintainability
[13:21] is orders of magnitude harder
[13:22] than the code runs and the test pass.
[13:24] Because the cost function of bad architecture
[13:27] is measured in months and years
[13:29] if you have a coding episode
[13:31] and then you only find out months later
[13:33] that like ooh, somebody vibed this a little bit too hard.
[13:35] It's really hard to propagate that reward signal
[13:38] back across the gap.
[13:39] And now the frontier is getting better, slowly.
[13:42] And since I know someone's gonna be
[13:43] in the YouTube comments about this,
[13:44] yes I know benchmarks and verifiers are different
[13:46] and they actually have to be separate data sets
[13:48] but they're shaped the same
[13:50] and the structure of these benchmarks
[13:51] is directionally correct.

[13:52] So we're gonna look at these as like
[13:53] what is the future of evaluating code maintainability?
[13:57] There's a really cool one called Sweet Marathon
[13:58] from Abundant AI where they do like 400 hour tasks
[14:01] of like clone all of Microsoft Excel
[14:03] every single feature.
[14:04] And they have some sophisticated reward channel stuff.
[14:07] DeepSwee from DataCurve is also like large tasks
[14:10] on OSS repos that are not actually in the training set
[14:14] because they were never actually built in the real world.
[14:16] And then you have Frontier Code from Cognition
[14:19] which is multi-PR tasks.
[14:20] They do interesting things like hey,
[14:22] if the model writes tests that don't fail
[14:23] on the pre-patch code then it gets penalized.
[14:26] And then we have a judge model that says okay,
[14:28] did this follow all of our code quality rules?

[14:31] So we're getting better but I think models
[14:32] judging quality can only go so far.
[14:35] If the model knew what good code looks like,
[14:38] it would probably write it in the first place.
[14:40] And review agents and throwing more tokens at the problem,
[14:43] it can raise the floor but we're still constrained
[14:47] by what we can teach during RL.
[14:49] And so I will posit that for now
[14:51] we're stuck reading the code.
[14:53] But we can still move pretty fast.
[14:54] And of course there's a world
[14:55] where this is solved in the future
[14:57] and if you wanna just keep yoloing prompts
[14:59] until you get to GPT-70
[15:00] you don't have to think about this by all means, please.
[15:03] But bit or less can be damned,
[15:04] we've got some problems to solve
[15:06] so let's engineer our way out of this.
[15:09] So turning the lights back on,

[15:10] we're gonna put the code review back.
[15:12] We're gonna embrace this approach
[15:14] of how do we plan up front to reduce the chance
[15:16] that we have a long or difficult review process.
[15:19] We're gonna find leverage,
[15:20] we're gonna use AI to help with this.
[15:22] The first thing we're gonna do
[15:23] is we're gonna do some sort of product review,
[15:25] understanding what problem we're solving,
[15:26] what's the desired behavior,
[15:28] maybe looking at mock-ups.
[15:29] Here's a product review I was working on yesterday
[15:31] with a mock-up of a new feature.
[15:33] Once we have our product review,
[15:34] we're gonna, by the way,
[15:36] small stuff still just goes straight to the agent.
[15:38] But once we have the product review
[15:39] we're gonna also do architecture, system architecture.
[15:41] A lot of people have been doing this for a while,

[15:43] component contracts, data models, constraints.
[15:46] This is an example of a dock that we build
[15:48] to understand how these systems are gonna fit together
[15:51] and what's like the high-level picture of it.
[15:53] From there we do something
[15:54] that I think is really under-emphasized
[15:56] in agent decoding these days,
[15:58] which is program design.
[15:59] I think people assume
[16:00] that once you get the architecture right
[16:02] the model can just cook.
[16:04] But we often look into the types and the method signatures,
[16:07] the program layout and the call stacks.
[16:09] And so here's some examples,
[16:10] I don't think you'll be able to read this one,
[16:11] but this is like the level of abstraction we're at
[16:13] is how are we actually gonna lay this stuff out
[16:15] and how are these systems gonna interact?
[16:18] Dylan Mulroy from Cloudflare

[16:19] talks a lot about how he's using these call graphs
[16:22] as part of his planning process.
[16:23] I think this is exactly right.
[16:25] And then once we've done the program design
[16:27] we can do this thing called vertical slices,
[16:29] which is the order of implementation,
[16:31] multi-repo coordination.
[16:32] How are we gonna build this across our entire system
[16:35] and how are we gonna check it along the way?
[16:37] I've talked a little bit
[16:37] about how models have horizontal plans.
[16:39] I won't go too deep into it.
[16:41] If you want to learn more about this
[16:42] you can go watch our talk from AI Engineer Miami.
[16:45] Couple shots of a doc like this
[16:47] going through the tests
[16:48] and the steps in between each phase.
[16:50] The main idea here is 30 minutes over here
[16:53] in pre-planning and alignment
[16:55] can save you hours in review.

[16:57] And so it's actually feasible
[16:59] to still read every line of code.
[17:02] We'll skip this part.
[17:03] Basically, the summary here is like
[17:06] you don't have too many PRs.
[17:08] If you're drowning in PRs
[17:09] you actually have too many bad PRs.
[17:13] Because a good PR is a joy to review.
[17:16] You're just reading through like,
[17:17] yep, this is great, this is what we discussed,
[17:18] this is what we talked about.
[17:20] But even if a PR needs 20% rework,
[17:23] which is generous for a lot of AI vibe coded slop,
[17:27] it's an emotional and intellectual burden
[17:30] on both the reviewer and the submitter.
[17:32] And so if you use model assisted planning and alignment
[17:35] your alignment is shorter
[17:36] because you used AI to get all the information at once.
[17:39] Your code review is faster
[17:41] because you aligned up front

[17:42] and your coding is faster because AI did it.
[17:44] And so now you're actually really moving faster
[17:46] but you're still reading everything
[17:47] and you're still owning the code.
[17:49] So, closing advice.
[17:52] It's easy to hear all this
[17:53] and be a little bummed out.
[17:55] I really like the world where we just YOLO everything
[17:58] and we can just like not have to ever read code ever again.
[18:01] But we're engineers and these are just constraints
[18:04] and models are good at certain things
[18:05] and they're not good at other things.
[18:07] And so go figure out how to solve problems
[18:09] given a set of constraints.
[18:11] Use loops, they're great.
[18:13] Go solve hard problems, seek leverage.
[18:16] If you wanna help with this
[18:17] we're building human layer.
[18:18] Human layer is an AI IDE and collaboration platform.

[18:21] It's building blocks for your software factory
[18:24] and soon to be better verifiers for software quality.
[18:28] We've got sort of a big mob for cloud code
[18:30] and codec style collaborative workspace.
[18:32] It walks you through the workflows
[18:33] for doing this sort of work.
[18:36] And we are talking to design partners.
[18:39] We are hiring founding engineers here in San Francisco
[18:42] and these slides are live.
[18:44] You can go get them right now.
[18:45] You can try human layer at humanlayer.com.
[18:48] It's free for small teams.
[18:50] Go solve hard problems in complex code bases.
[18:52] Thank you all for your energy.
