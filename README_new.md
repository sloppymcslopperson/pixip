# PIXIP

`Pixies In Parallel` (or `Pi X IP` if you're boring)

Pixip is server-side web-accessable agent that wraps Pi,
and provides additional features.

To start using Pixip, from within this repository
run `npx run pixip`

## Design Philosophy

Pixip is designed to be easy to set up. It has sensible defaults, and can be run from within a sandbox with a 
single command. 

Pixip is designed to be mobile-first and responsive. 
It is developed within itself over a variety of internet
connections, and any latency or 
slowness observed is ruthlessly hunted down and 
eliminated. Connections with the agent from the web ui
are handled over a websocket to give the quickest possible 
exchange. Agent connections are managed intelligently,
so that only the connections that are needed are active,
and reconnects are as quick as possible.

Pixip is designed with security in mind. It defers
authentication and sandboxing to the environment
within which it is running.
Any program might experience a vulnerabilty, especially
with NPM involved, and by not handling security
concerns within Pixip itself we ensure that any
such issues will not be in those areas. This also 
allows a sysadmin setting up Pixip instances to set up
a security story that best fits their use case, and Pixip
is designed to provide as little friction for this
as possible.

## Development, and AI Use

Pixip is developed with AI assistance. The system is
designed and the code reviewed by a seasoned developer
and sysadmin. This file and other 
user-facing documentation are being written by a human.
and the UI is designed by hand by a professional
UI designer.

