Pre-submission audit. Run on 2026-08-17, not before.

Walk spec/02-COMPLIANCE-MATRIX.md section F line by line. For each item,
report PASS or FAIL with evidence, checking the repo rather than assuming:

- LICENSE file present, MIT, and visible in the GitHub About panel
- repo public
- README carries setup instructions, prior-work disclosure, third-party
  licences, and the line stating the demo needs no account or key
- .env absent from the repo and from git history
- benchmark results committed under bench/results/ and reproducible from a
  clean clone
- demo URL loads anonymously in a private window
- video under 3:00, public, English, shows the memory layer, no third-party
  marks in frame
- Devpost description carries the benchmark table and the architecture
  diagram
- the CockroachDB tools answer and the AWS services answer are ready to paste
- AWS budget alarm active

Re-fetch the rules page and diff it against the compliance matrix. The
sponsor may amend the rules at any time.

Report only. Do not fix anything on submission day without telling me first.
