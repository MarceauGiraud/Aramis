# /db

Manage database schema and migrations.

## Usage

- `/db push` - Push schema changes to database
- `/db generate` - Generate Prisma client
- `/db studio` - Open Prisma Studio
- `/db reset` - Reset database (WARNING: deletes all data)

## Instructions

Parse the argument and run the appropriate command:

### push
```bash
pnpm --filter @aramis/database push
```

### generate
```bash
pnpm --filter @aramis/database generate
```

### studio
```bash
pnpm --filter @aramis/database studio
```

### reset
```bash
pnpm --filter @aramis/database db:reset
```

If no argument is provided, show available commands to the user.

## Schema Location

The Prisma schema is at: `packages/database/prisma/schema.prisma`

When modifying the schema:
1. Edit the schema file
2. Run `/db push` to apply changes
3. Run `/db generate` to update the client
