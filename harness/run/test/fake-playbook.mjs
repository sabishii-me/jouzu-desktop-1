// Stand-in playbook for the runner's self-test: only the case list.
console.log(JSON.stringify([
  { name: 'Passes', langs: ['en', 'ja'] },
  { name: 'Fails', langs: ['en'] },
  { name: 'Hangs', langs: ['en'] },
  { name: 'Crashes the exam', langs: ['en'] },
  { name: 'Skips with a planned reason', langs: ['en'] },
  { name: 'Skips without a planned reason', langs: ['en'] },
  { name: 'Flaky', langs: ['en'] },
  { name: 'Leaves a process behind', langs: ['en'] },
]));
