# /check-recording

Verify the recording system is properly configured and working.

## Instructions

Run the following checks and report status:

### 1. Check FFmpeg
```bash
ffmpeg -version 2>/dev/null | head -1 || echo "FFmpeg NOT FOUND"
```

### 2. Check X11 Display
```bash
echo "DISPLAY=$DISPLAY"
xdpyinfo -display :99 2>/dev/null | head -3 || echo "Xvfb NOT RUNNING on :99"
```

### 3. Check PulseAudio
```bash
pactl info 2>/dev/null | grep "Server Name" || echo "PulseAudio NOT RUNNING"
pactl list sinks short 2>/dev/null || echo "No audio sinks available"
```

### 4. Check S3 Connection
```bash
curl -s ${S3_ENDPOINT:-http://localhost:9000}/minio/health/live && echo "S3 OK" || echo "S3 NOT REACHABLE"
```

### 5. Check Recording Files
```bash
ls -la apps/bot-worker/src/lib/*streamer*.ts apps/bot-worker/src/lib/*orchestrator*.ts apps/bot-worker/src/lib/*uploader*.ts 2>/dev/null
```

## Report Format

Provide a status table:

| Component | Status | Notes |
|-----------|--------|-------|
| FFmpeg | OK/MISSING | version |
| Xvfb | OK/NOT RUNNING | display |
| PulseAudio | OK/NOT RUNNING | sinks |
| S3 | OK/UNREACHABLE | endpoint |
| Recording Files | OK/MISSING | count |

If running in Docker, note that Xvfb and PulseAudio are started by the entrypoint script.
