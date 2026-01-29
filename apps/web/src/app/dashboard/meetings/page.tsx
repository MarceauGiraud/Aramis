'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Meeting {
  id: string;
  title: string;
  platform: 'ZOOM' | 'TEAMS' | 'GOOGLE_MEET';
  meetingUrl: string;
  scheduledStart: string;
  scheduledEnd?: string;
  status: string;
  recordingEnabled: boolean;
  calendarEvent?: {
    calendar: {
      name: string;
      color?: string;
    };
  };
}

const PLATFORM_ICONS: Record<string, string> = {
  ZOOM: '📹',
  TEAMS: '👥',
  GOOGLE_MEET: '🎥',
};

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: 'bg-blue-100 text-blue-800',
  JOINING: 'bg-yellow-100 text-yellow-800',
  RECORDING: 'bg-red-100 text-red-800',
  PROCESSING: 'bg-purple-100 text-purple-800',
  COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-gray-100 text-gray-800',
};

export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'upcoming' | 'past' | 'all'>('upcoming');

  useEffect(() => {
    fetchMeetings();
  }, [filter]);

  const fetchMeetings = async () => {
    try {
      const response = await fetch(`/api/meetings?filter=${filter}`);
      const data = await response.json();
      setMeetings(data.meetings || []);
    } catch (error) {
      console.error('Failed to fetch meetings:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleRecording = async (meetingId: string, enabled: boolean) => {
    try {
      await fetch(`/api/meetings/${meetingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordingEnabled: enabled }),
      });

      setMeetings(meetings.map(m =>
        m.id === meetingId ? { ...m, recordingEnabled: enabled } : m
      ));
    } catch (error) {
      console.error('Failed to toggle recording:', error);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const formatDuration = (start: string, end?: string) => {
    if (!end) return '';
    const startDate = new Date(start);
    const endDate = new Date(end);
    const minutes = Math.round((endDate.getTime() - startDate.getTime()) / 60000);
    if (minutes < 60) return `${minutes}min`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h${remainingMinutes > 0 ? remainingMinutes : ''}`;
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              Mes Réunions
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              Gérez vos enregistrements de réunions
            </p>
          </div>

          <Link
            href="/dashboard/calendars"
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >
            Connecter un calendrier
          </Link>
        </div>

        {/* Filters */}
        <div className="flex gap-2 mb-6">
          {(['upcoming', 'past', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                filter === f
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              {f === 'upcoming' ? 'À venir' : f === 'past' ? 'Passées' : 'Toutes'}
            </button>
          ))}
        </div>

        {/* Meetings List */}
        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
            <p className="text-gray-500 mt-4">Chargement...</p>
          </div>
        ) : meetings.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-xl p-12 text-center">
            <div className="text-4xl mb-4">📅</div>
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              Aucune réunion
            </h3>
            <p className="text-gray-500 dark:text-gray-400 mb-4">
              Connectez votre calendrier pour voir vos réunions
            </p>
            <Link
              href="/dashboard/calendars"
              className="text-blue-600 hover:text-blue-700 font-medium"
            >
              Connecter Google Calendar ou Outlook →
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {meetings.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                onToggleRecording={toggleRecording}
                formatDate={formatDate}
                formatDuration={formatDuration}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface MeetingCardProps {
  meeting: Meeting;
  onToggleRecording: (id: string, enabled: boolean) => void;
  formatDate: (date: string) => string;
  formatDuration: (start: string, end?: string) => string;
}

function MeetingCard({ meeting, onToggleRecording, formatDate, formatDuration }: MeetingCardProps) {
  const isPast = new Date(meeting.scheduledStart) < new Date();
  const isRecording = meeting.status === 'RECORDING';

  return (
    <div className={`bg-white dark:bg-gray-800 rounded-xl p-6 shadow-sm border border-gray-200 dark:border-gray-700 ${
      isRecording ? 'ring-2 ring-red-500' : ''
    }`}>
      <div className="flex items-start justify-between">
        {/* Left side - Meeting info */}
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-2xl">{PLATFORM_ICONS[meeting.platform]}</span>
            <div>
              <Link
                href={`/dashboard/meetings/${meeting.id}`}
                className="text-lg font-semibold text-gray-900 dark:text-white hover:text-blue-600 transition-colors"
              >
                {meeting.title}
              </Link>
              {meeting.calendarEvent?.calendar && (
                <span
                  className="ml-2 text-xs px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor: meeting.calendarEvent.calendar.color || '#e5e7eb',
                    color: '#374151'
                  }}
                >
                  {meeting.calendarEvent.calendar.name}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 text-sm text-gray-600 dark:text-gray-400">
            <span>{formatDate(meeting.scheduledStart)}</span>
            {meeting.scheduledEnd && (
              <span className="text-gray-400">
                {formatDuration(meeting.scheduledStart, meeting.scheduledEnd)}
              </span>
            )}
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[meeting.status]}`}>
              {meeting.status === 'SCHEDULED' ? 'Programmé' :
               meeting.status === 'RECORDING' ? '🔴 En cours' :
               meeting.status === 'COMPLETED' ? 'Terminé' :
               meeting.status === 'PROCESSING' ? 'Traitement...' :
               meeting.status}
            </span>
          </div>
        </div>

        {/* Right side - Recording toggle */}
        <div className="flex items-center gap-4">
          {!isPast && meeting.status === 'SCHEDULED' && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600 dark:text-gray-400">
                Enregistrer
              </span>
              <button
                onClick={() => onToggleRecording(meeting.id, !meeting.recordingEnabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  meeting.recordingEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    meeting.recordingEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          )}

          {meeting.status === 'COMPLETED' && (
            <Link
              href={`/dashboard/meetings/${meeting.id}`}
              className="bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Voir l'enregistrement
            </Link>
          )}

          {isRecording && (
            <div className="flex items-center gap-2 text-red-600">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
              </span>
              <span className="text-sm font-medium">En direct</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
