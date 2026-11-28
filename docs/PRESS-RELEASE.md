<!-- Working draft as provided by the owner. Left unedited on purpose so the
deviation audit has a stable source. -->

PRESS RELEASE

(for internal use only, not to be released to the public)

PixiP: A no-fuss personal cloud coding agent, running on your hardware and built around Pi.

Coding agent users who want a remote agent front-end no longer have to compromise

Anywheresville, USA, late 2026 - When choosing between remote front-ends for open source code-first agents, users have to settle on “good-enough”. Tmux and its wrappers are useful, but are a pain to use on mobile or over spotty connections. General-purpose agent web front-ends require multiple frustrating steps to get working, and harness-specific front-ends lack extensibility, human-first UX, or security stories that are designed for people who just want things to work.

Introducing PixiP. It a cloud agent front-end designed from the ground up to be better then “good-enough”. It is Pi at its core, so your existing Pi workflows, extensions, and provider connections are used out of the box and can be added or modified easily. If you don’t already use Pi, no problem, PixiP bundles it so that you don’t need to configure it before getting started. The install process is extremely simple- just run the program on Windows, Mac, or Linux, load the page, and begin prompting. The interface is designed with care by a real human UX/UI designer, ensuring that the human is always prioritized by all else.

PixiP is developed with security and safety in mind, and is designed to be used safety with little configuration. It itself provides no sandbox and doesn’t enforce any network security of access models, and is designed to be effortlessly slotted into whatever system makes sense for the user. Endpoints are kept minimal and thoroughly documented, the process does not require any special user permissions while running, and it only accepts inbound connections via the exact connection parameters specified when the process is started. As it doesn’t provide a sandbox of its own, it can be wrapped in a Docker image, a MicroVM, a remote VPS, or any other kind of sandbox without conflicts or any loss of features.

PixiP also bundles functionality that a user will find immediately useful. It has first-class Git worktree support, including simple worktree creation and a streamlined agentic merge workflow. It has support for mobile notifications and features a built-in mailbox to which agents can send messages and sanitized, safe HTML reports, meaning that you never have to give your agent access to your email or other messaging service (or even the internet at all, if you want to block access via your sandbox!) to allow it to communicate asynchronously with you. It also includes a bespoke A2UI implementation, allowing agents and extensions (such as the built-in questionnaire tool) to deliver first-class safety-first user interactions.

PixiP is developed in PixiP, and has been built to effortlessly handle the rigors and inconsistencies of a modern mobile agentic workflow. It handles spotty mobile networks easily, letting you resume work as though nothing happened if you suffer a random disconnect. It is designed to look great at any resolution on any device, adapting to your workflow and letting you access functionality in a way that makes sense for the actual hardware that you’re using. Network connections and memory are handled intelligently, so that stutters and hiccups are kept to an absolute minimum. Conversations are recorded durably, so even if the server goes down the agent is ready to resume where it left off once you’re ready to continue. 

Pixip is designed to be used in a variety of environments. If you’re a hacker hosting who likes to modify your tools, PixiP can hot reload itself so that extensions and even modifications to the app itself can be seen immediately. If you’re a sysadmin who wants to set up PixiP in a reliable, predictable way, a single flag locks it down so that you don’t have to worry about a user making a change that you’ll need to fix at 4 in the morning on a Saturday. 

Pixip broadcasts what it does to any connected device, allowing for seamless multi-device workflows and instant device handoffs. This also means that it has “pair-programming” support out of the box, and if it finds the X-Forwarded-User HTTP header it will automatically use its value to show who sent user messages. Sessions reconnect quickly even when a mobile browser aggressively closes them, and 

PixiP’s sand defaults are what allow it to work effortlessly out of the box, but no configuration is right for every use case. If you find that something needs changing, it has an extensive set of configuration points available via a simple config.toml file that can be adjusted to fit your environment precisely.  

“PixiP is great! I set it up in minutes, and it was easy to make it fit my needs. I’ve been working with it for weeks and I’ve never been more productive while lounging in a bubblebath.” - Sloppy McSlopperson

PixiP is available for free, right now, from NPM or Github.
