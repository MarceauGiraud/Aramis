'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Meeting {
  id: string;
  title: string;
  platform: 'ZOOM' | 'TEAMS' | 'GOOGLE_MEET';
  meetingUrl: string;
  scheduledStart: string;
  actualStart?: string;
  actualEnd?: string;
  duration?: number;
  status: string;
  recording?: {
    status: string;
    videoUrl?: string;
  };
  transcript?: {
    status: string;
    wordCount?: number;
  };
}

const platformIcons: Record<string, string> = {
  ZOOM: '📹',
  TEAMS: '👥',
  GOOGLE_MEET: '🎥',
};

const statusColors: Record<string, string> = {
  SCHEDULED: 'bg-blue-100 text-blue-800',
  JOINING: 'bg-yellow-100 text-yellow-800',
  WAITING: 'bg-yellow-100 text-yellow-800',
  RECORDING: 'bg-red-100 text-red-800',
  PROCESSING: 'bg-purple-100 text-purple-800',
  COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-gray-100 text-gray-800',
};

const statusLabels: Record<string, string> = {
  SCHEDULED: 'Planifié',
  JOINING: 'Connexion...',
  WAITING: 'En attente',
  RECORDING: 'Enregistrement',
  PROCESSING: 'Traitement',
  COMPLETED: 'Terminé',
  FAILED: 'Échoué',
  CANCELLED: 'Annulé',
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "À l'instant";
  if (diffMins < 60) return `Il y a ${diffMins} min`;
  if (diffHours < 24) return `Il y a ${diffHours}h`;
  if (diffDays < 7) return `Il y a ${diffDays}j`;

  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
  });
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export default function Dashboard() {
  const [meetingUrl, setMeetingUrl] = useState('');
  const [meetingTitle, setMeetingTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loadingMeetings, setLoadingMeetings] = useState(true);

  // Fetch meetings on mount
  useEffect(() => {
    fetchMeetings();
  }, []);

  const fetchMeetings = async () => {
    try {
      const response = await fetch('/api/meetings?limit=10');
      if (response.ok) {
        const data = await response.json();
        setMeetings(data.meetings || []);
      }
    } catch (err) {
      console.error('Failed to fetch meetings:', err);
    } finally {
      setLoadingMeetings(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: meetingTitle || 'Nouveau meeting',
          meetingUrl,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Erreur lors de la création');
      }

      setMeetingUrl('');
      setMeetingTitle('');
      // Refresh meetings list
      fetchMeetings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Aramis</h1>
              <p className="text-sm text-gray-500">Meeting Recorder</p>
            </div>
            <nav className="flex gap-4">
              <Link
                href="/dashboard"
                className="text-blue-600 font-medium"
              >
                Dashboard
              </Link>
              <Link
                href="/dashboard/meetings"
                className="text-gray-600 hover:text-gray-900"
              >
                Tous les meetings
              </Link>
            </nav>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* New Meeting Form */}
        <section className="bg-white rounded-lg p-6 shadow-sm border mb-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Enregistrer un meeting
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex gap-4">
              <input
                type="text"
                value={meetingTitle}
                onChange={(e) => setMeetingTitle(e.target.value)}
                placeholder="Titre du meeting (optionnel)"
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div className="flex gap-4">
              <input
                type="url"
                value={meetingUrl}
                onChange={(e) => setMeetingUrl(e.target.value)}
                placeholder="URL du meeting (Zoom, Teams, ou Google Meet)"
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
              <button
                type="submit"
                disabled={isLoading}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-6 py-2 rounded-lg font-medium transition-colors whitespace-nowrap"
              >
                {isLoading ? 'Démarrage...' : 'Démarrer'}
              </button>
            </div>
            {error && (
              <p className="text-red-500 text-sm">{error}</p>
            )}
          </form>
        </section>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-white rounded-lg p-4 shadow-sm border">
            <p className="text-sm text-gray-500">Total meetings</p>
            <p className="text-2xl font-bold text-gray-900">{meetings.length}</p>
          </div>
          <div className="bg-white rounded-lg p-4 shadow-sm border">
            <p className="text-sm text-gray-500">En cours</p>
            <p className="text-2xl font-bold text-yellow-600">
              {meetings.filter((m) => ['RECORDING', 'JOINING', 'WAITING'].includes(m.status)).length}
            </p>
          </div>
          <div className="bg-white rounded-lg p-4 shadow-sm border">
            <p className="text-sm text-gray-500">Terminés</p>
            <p className="text-2xl font-bold text-green-600">
              {meetings.filter((m) => m.status === 'COMPLETED').length}
            </p>
          </div>
          <div className="bg-white rounded-lg p-4 shadow-sm border">
            <p className="text-sm text-gray-500">Échoués</p>
            <p className="text-2xl font-bold text-red-600">
              {meetings.filter((m) => m.status === 'FAILED').length}
            </p>
          </div>
        </div>

        {/* Recent Meetings */}
        <section className="bg-white rounded-lg shadow-sm border">
          <div className="p-4 border-b flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Meetings récents</h2>
            <Link
              href="/dashboard/meetings"
              className="text-sm text-blue-600 hover:underline"
            >
              Voir tous →
            </Link>
          </div>

          {loadingMeetings ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <p className="mt-4 text-gray-500">Chargement...</p>
            </div>
          ) : meetings.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <p>Aucun meeting pour l'instant.</p>
              <p className="text-sm mt-2">Collez une URL de meeting ci-dessus pour commencer.</p>
            </div>
          ) : (
            <div className="divide-y">
              {meetings.slice(0, 5).map((meeting) => (
                <Link
                  key={meeting.id}
                  href={`/dashboard/meetings/${meeting.id}`}
                  className="block p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{platformIcons[meeting.platform]}</span>
                      <div>
                        <p className="font-medium text-gray-900">{meeting.title}</p>
                        <p className="text-sm text-gray-500">
                          {formatDate(meeting.scheduledStart)}
                          {meeting.duration && ` - ${formatDuration(meeting.duration)}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {/* Status indicators */}
                      {meeting.transcript?.status === 'COMPLETED' && (
                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                          Transcrit
                        </span>
                      )}
                      {meeting.recording?.status === 'COMPLETED' && (
                        <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                          Enregistré
                        </span>
                      )}
                      <span
                        className={`text-xs px-2 py-1 rounded-full font-medium ${
                          statusColors[meeting.status] || 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {statusLabels[meeting.status] || meeting.status}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
