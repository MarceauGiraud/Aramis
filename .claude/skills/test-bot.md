# /test-bot

Run tests for the bot-worker package.

## Instructions

1. Navigate to the bot-worker directory context

2. Run the available tests:
```bash
cd apps/bot-worker

# Run all tests
pnpm test

# Or run specific test files
npx tsx src/__tests__/video-streamer.test.ts
npx tsx src/lib/audio-streamer.test.ts
```

3. If tests fail:
   - Read the error output
   - Fix the failing tests or the code they're testing
   - Re-run until all tests pass

4. Report results to the user with a summary of:
   - Number of tests passed/failed
   - Any issues found and fixed
