# /logs

View logs from various services.

## Usage

- `/logs bot` - Bot worker logs
- `/logs web` - Web app logs
- `/logs all` - All service logs

## Instructions

### bot
```bash
docker-compose logs --tail=100 -f bot-worker
```

### web
```bash
docker-compose logs --tail=100 -f web
```

### all
```bash
docker-compose logs --tail=50 -f
```

If not using Docker, check for local log files or process output.

### Filtering logs

To search for specific patterns:
```bash
docker-compose logs bot-worker 2>&1 | grep -i "error"
docker-compose logs bot-worker 2>&1 | grep -i "recording"
```

### Log levels

The bot-worker uses Winston logger with levels:
- `error` - Errors that need attention
- `warn` - Warnings
- `info` - Normal operation info
- `debug` - Detailed debug info (enable with BOT_DEBUG=true)
