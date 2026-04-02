import { NextRequest, NextResponse } from 'next/server';

const BOT_WORKER_URL = process.env.BOT_WORKER_URL || 'http://localhost:8765';

// GET /api/bots/:id/screenshots - list and proxy screenshots from bot-worker
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const res = await fetch(`${BOT_WORKER_URL}/screenshots/${params.id}`, {
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json({ screenshots: [] });
    }

    const data = await res.json();

    // Convert bot-worker paths to web app proxy paths
    const screenshots = (data.screenshots || []).map((path: string) => {
      const filename = path.split('/').pop();
      return {
        filename,
        url: `${BOT_WORKER_URL}${path}`,
        // Extract step info from filename: meetingId_NNN_stepname.png
        step: filename?.replace(/^[^_]+_\d+_/, '').replace('.png', '') || '',
        order: parseInt(filename?.match(/_(\d+)_/)?.[1] || '0', 10),
      };
    });

    // Sort by order
    screenshots.sort((a: { order: number }, b: { order: number }) => a.order - b.order);

    return NextResponse.json({ screenshots });
  } catch (error) {
    console.error('Error fetching screenshots:', error);
    return NextResponse.json({ screenshots: [] });
  }
}
