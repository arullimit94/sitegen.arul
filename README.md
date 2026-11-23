# sitegen

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/arullimit94/sitegen.arul/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/arullimit94/sitegen.arul/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

`sitegen` is a faster drop-in for makefun-site 1.0.0. It reads a site's sources — Markdown with makefun-site's own front matter, template dialect and Markdown subset — and writes exactly the output tree makefun-site 1.0.0 writes, byte for byte, only faster: a fused Markdown lexer/renderer with a single-pass inline scanner, an array-accumulating template renderer, memoized slugs and allocation-free word counting.

## Usage

`main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, answers each with `run` from `solve.js`, and writes `/output/answers.json`. It uses only the Node 22 standard library.

## Practice score

3 of 3 practice cases passed with the kit's `grade-local` (L1 regrade reproduced byte for byte). Locally, on the practice set, it runs at about 0.78 s of process CPU against the house baseline's 1.26 s on the same machine.
