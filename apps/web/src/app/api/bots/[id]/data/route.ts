import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@aramis/database';
import { apiError } from '@/lib/api-helpers';
import { deleteS3Prefix } from '@/lib/s3';

// DELETE /api/bots/:id/data - GDPR data deletion
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      include: {
        recording: true,
        transcript: true,
        summary: true,
        botSession: true,
      },
    });

    if (!meeting) {
      return apiError('NOT_FOUND', 'Bot not found', 404);
    }

    // Delete S3 data for this meeting
    const s3Prefix = `recordings/${params.id}/`;
    let s3Deleted = 0;
    try {
      s3Deleted = await deleteS3Prefix(s3Prefix);
    } catch (error) {
      console.error('Error deleting S3 data:', error);
      // Continue with DB deletion even if S3 fails
    }

    // Delete the meeting and all related data via cascade
    await prisma.meeting.delete({
      where: { id: params.id },
    });

    return NextResponse.json({
      success: true,
      deleted: {
        meeting: true,
        recording: !!meeting.recording,
        transcript: !!meeting.transcript,
        summary: !!meeting.summary,
        botSession: !!meeting.botSession,
        s3Objects: s3Deleted,
      },
    });
  } catch (error) {
    console.error('Error performing data deletion:', error);
    return apiError('INTERNAL_ERROR', 'Failed to delete data', 500);
  }
}
