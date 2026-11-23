# Fast static site builder

[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Pasletik/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Pasletik/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

An entry for the make.fun bounty [Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122):
`solve.js` is a dependency-free ES module whose `run(input)` returns exactly the output tree makefun-site 1.0.0
returns for a case's site — every page, index, tag page, static file and the build report, byte for byte — computed
with single-pass scanners, run-based HTML escaping and small caches (slugs, long dates, cards, resolved links)
instead of per-character regex work. `main.ts` is the harness driver: it reads `/input/cases.json`, answers each
case with `run`, and writes `/output/answers.json`.

Join make.fun with my referral: https://make.fun/r/fdvwjd8e
