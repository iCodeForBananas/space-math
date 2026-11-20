# Contributing

Thanks for helping kids get better at math! Bug reports, new question types,
accessibility fixes and translations are all welcome.

## Ground rules

Space Math is for young children, so a few things are non-negotiable:

- **No data leaves the device.** No analytics, ads, accounts, network calls
  or third-party SDKs that phone home. (This is also what keeps it eligible
  for the kids' categories in both app stores.)
- **Big, forgiving touch targets.** Assume a five-year-old with a tablet.
- **One answer per question.** Right or wrong, the game moves on; the
  schedule handles review.

## Making a change

1. Fork, then branch from `main`.
2. `npm install`, then `npm run dev` to play it as you work.
3. Add or update tests next to the code (`*.test.ts`) for anything in
   `src/lib/`. `npm test` must pass.
4. Open a pull request. CI tests it and builds Android and iOS apps you can
   download from the run to try it on a device.

### Adding a skill

1. Add a `ProblemType` and its entry to `SKILLS` in
   `src/lib/spaceMathSkills.ts`, in the right place on the ladder (easiest
   first).
2. Teach `buildProblem` in `src/lib/spaceMathGenerator.ts` to make it.
3. `spaceMathSkills.test.ts` checks every skill produces a valid question.

Keep the ladder order stable: saved progress is keyed by skill `key`, so
never rename or reuse a key.

### Changing the icon or splash screen

Edit the images in `resources/`, then run `npm run assets` to regenerate
every Android and iOS size.

## Reporting a bug

Open an issue with the device, OS version, what you tapped and what
happened. A screenshot helps.
