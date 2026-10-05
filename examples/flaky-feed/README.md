# Flaky feed

A feed that answers "busy, retry" for one item forever. Use it to watch the loop circuit work.

With TokenMunim installed, start Claude Code in this repo and ask:

> Run `python3 examples/flaky-feed/fetch.py`. The feed is flaky, so if it says busy, just run the same command again.

Claude retries. After the same failure three times in a row (the default loop limit), TokenMunim blocks the next retry and tells Claude to read the error and change approach. The pane shows the trip in red, and the tape shows the blocked call.
