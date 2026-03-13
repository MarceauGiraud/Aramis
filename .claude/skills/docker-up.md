# /docker-up

Start the Docker infrastructure for local development.

## Instructions

1. Start the infrastructure services:
```bash
docker-compose up -d postgres redis minio
```

2. Wait for services to be healthy:
```bash
docker-compose ps
```

3. If starting the bot-worker:
```bash
docker-compose up -d --build bot-worker
```

4. Show the user the running containers and their status.

5. If any service fails to start:
   - Check logs: `docker-compose logs <service>`
   - Report the issue to the user

## Service URLs

- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`
- MinIO Console: `http://localhost:9001` (minioadmin/minioadmin)
- MinIO S3 API: `http://localhost:9000`
