# /build

Build the project and fix any compilation errors.

## Instructions

1. Run the build command:
```bash
pnpm build
```

2. If there are TypeScript errors:
   - Read the error messages carefully
   - Fix each error in the relevant files
   - Re-run the build until it passes

3. If there are missing dependencies:
   - Run `pnpm install`
   - Then retry the build

4. Report the final build status to the user.

## Common Build Issues

- **Missing Prisma client**: Run `pnpm --filter @aramis/database generate`
- **Type errors in shared**: Build shared first: `pnpm --filter @aramis/shared build`
- **Import errors**: Check that all exports are correct in package index files
