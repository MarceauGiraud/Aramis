'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

interface TranscriptSegment {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
  confidence?: number;
  speaker?: {
    id: string;
    label: string;
    identifiedName?: string;
  };
}

interface Transcript {
  id: string;
  status: string;
  fullText?: string;
  wordCount?: number;
  language?: string;
  confidence?: number;
  segments: TranscriptSegment[];
}

interface Summary {
  id: string;
  status: string;
  overview?: string;
  keyPoints?: string[];
  decisions?: string[];
  actionItems?: Array<{
    task: string;
    assignee?: string;
    dueDate?: string;
  }>;
  nextSteps?: string;
}

interface Recording {
  id: string;
  status: string;
  videoUrl?: string;
  audioUrl?: string;
  duration?: number;
  fileSize?: number;
}

interface Participant {
  id: string;
  name: string;
  email?: string;
  isHost: boolean;
  joinedAt?: string;
  leftAt?: string;
}

interface Meeting {
  id: string;
  title: string;
  platform: 'ZOOM' | 'TEAMS' | 'GOOGLE_MEET';
  meetingUrl: string;
  scheduledStart: string;
  scheduledEnd?: string;
  actualStart?: string;
  actualEnd?: string;
  duration?: number;
  status: string;
  errorMessage?: string;
  recording?: Recording;
  transcript?: Transcript;
  summary?: Summary;
  participants?: Participant[];
}

const platformNames: Record<string, string> = {
  ZOOM: 'Zoom',
  TEAMS: 'Microsoft Teams',
  GOOGLE_MEET: 'Google Meet',
};

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

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Speaker colors for visual differentiation
const speakerColors = [
  'bg-blue-50 border-blue-200',
  'bg-green-50 border-green-200',
  'bg-purple-50 border-purple-200',
  'bg-orange-50 border-orange-200',
  'bg-pink-50 border-pink-200',
  'bg-cyan-50 border-cyan-200',
];

export default function MeetingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'transcript' | 'summary' | 'participants' | 'chat' | 'bot-activity'>('bot-activity');
  const [searchQuery, setSearchQuery] = useState('');
  const [pauseLoading, setPauseLoading] = useState(false);
  const [botLogs, setBotLogs] = useState<Array<{ id: string; level: string; message: string; metadata?: any; createdAt: string }>>([]);
  const [botScreenshots, setBotScreenshots] = useState<Array<{ filename: string; url: string; step: string; order: number }>>([]);
  const [selectedScreenshot, setSelectedScreenshot] = useState<string | null>(null);

  useEffect(() => {
    async function fetchMeeting() {
      try {
        const response = await fetch(`/api/meetings/${params.id}`);
        if (!response.ok) {
          if (response.status === 404) {
            setError('Meeting non trouvé');
          } else {
            setError('Erreur lors du chargement du meeting');
          }
          return;
        }
        const data = await response.json();
        setMeeting(data);
      } catch (err) {
        setError('Erreur de connexion');
      } finally {
        setLoading(false);
      }
    }

    if (params.id) {
      fetchMeeting();
    }
  }, [params.id]);

  // Poll bot logs and screenshots
  useEffect(() => {
    if (!params.id) return;

    async function fetchBotActivity() {
      try {
        const [logsRes, screenshotsRes] = await Promise.all([
          fetch(`/api/bots/${params.id}/events?limit=100`),
          fetch(`/api/bots/${params.id}/screenshots`),
        ]);

        if (logsRes.ok) {
          const logsData = await logsRes.json();
          setBotLogs(logsData.data || []);
        }

        if (screenshotsRes.ok) {
          const screenshotsData = await screenshotsRes.json();
          setBotScreenshots(screenshotsData.screenshots || []);
          // Auto-select latest screenshot
          if (screenshotsData.screenshots?.length > 0) {
            setSelectedScreenshot((prev: string | null) => {
              const latest = screenshotsData.screenshots[screenshotsData.screenshots.length - 1].url;
              return prev || latest;
            });
          }
        }
      } catch {
        // Ignore polling errors
      }
    }

    fetchBotActivity();

    // Poll every 3 seconds when meeting is active
    const isActive = meeting?.status && ['JOINING', 'WAITING', 'RECORDING', 'PROCESSING'].includes(meeting.status);
    if (isActive) {
      const interval = setInterval(fetchBotActivity, 3000);
      return () => clearInterval(interval);
    }
  }, [params.id, meeting?.status]);

  // Also re-fetch meeting data periodically when active
  useEffect(() => {
    if (!params.id || !meeting) return;
    const isActive = ['JOINING', 'WAITING', 'RECORDING', 'PROCESSING'].includes(meeting.status);
    if (!isActive) return;

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/meetings/${params.id}`);
        if (response.ok) {
          const data = await response.json();
          setMeeting(data);
        }
      } catch { /* ignore */ }
    }, 5000);

    return () => clearInterval(interval);
  }, [params.id, meeting?.status]);

  const handlePause = async () => {
    setPauseLoading(true);
    try {
      await fetch(`/api/bots/${params.id}/pause`, { method: 'POST' });
    } catch {
      // Ignore errors
    } finally {
      setPauseLoading(false);
    }
  };

  const handleResume = async () => {
    setPauseLoading(true);
    try {
      await fetch(`/api/bots/${params.id}/resume`, { method: 'POST' });
    } catch {
      // Ignore errors
    } finally {
      setPauseLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Chargement...</p>
        </div>
      </div>
    );
  }

  if (error || !meeting) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 text-lg">{error || 'Meeting non trouvé'}</p>
          <Link href="/dashboard/meetings" className="mt-4 inline-block text-blue-600 hover:underline">
            Retour aux meetings
          </Link>
        </div>
      </div>
    );
  }

  // Filter transcript segments by search query
  const filteredSegments = meeting.transcript?.segments?.filter((segment) =>
    searchQuery ? segment.text.toLowerCase().includes(searchQuery.toLowerCase()) : true
  ) || [];

  // Get unique speakers for color mapping
  const speakerColorMap = new Map<string, string>();
  meeting.transcript?.segments?.forEach((segment) => {
    if (segment.speaker && !speakerColorMap.has(segment.speaker.id)) {
      speakerColorMap.set(
        segment.speaker.id,
        speakerColors[speakerColorMap.size % speakerColors.length]
      );
    }
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard/meetings"
              className="text-gray-500 hover:text-gray-700"
            >
              ← Retour
            </Link>
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{platformIcons[meeting.platform]}</span>
                <h1 className="text-xl font-semibold text-gray-900">{meeting.title}</h1>
                <span
                  className={`px-2 py-1 text-xs font-medium rounded-full ${statusColors[meeting.status] || 'bg-gray-100 text-gray-800'}`}
                >
                  {statusLabels[meeting.status] || meeting.status}
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                {platformNames[meeting.platform]} - {formatDate(meeting.scheduledStart)}
              </p>
            </div>
            {/* Pause/Resume buttons */}
            {meeting.status === 'RECORDING' && (
              <div className="flex gap-2">
                <button
                  onClick={handlePause}
                  disabled={pauseLoading}
                  className="px-4 py-2 text-sm font-medium text-yellow-700 bg-yellow-100 rounded-lg hover:bg-yellow-200 disabled:opacity-50"
                >
                  {pauseLoading ? '...' : 'Pause'}
                </button>
                <button
                  onClick={handleResume}
                  disabled={pauseLoading}
                  className="px-4 py-2 text-sm font-medium text-green-700 bg-green-100 rounded-lg hover:bg-green-200 disabled:opacity-50"
                >
                  {pauseLoading ? '...' : 'Reprendre'}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Error Message */}
        {meeting.errorMessage && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800 font-medium">Erreur</p>
            <p className="text-red-600 text-sm mt-1">{meeting.errorMessage}</p>
          </div>
        )}

        {/* Meeting Info Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {/* Duration */}
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <p className="text-sm text-gray-500">Durée</p>
            <p className="text-lg font-semibold text-gray-900">
              {meeting.duration ? formatDuration(meeting.duration) : 'Non disponible'}
            </p>
          </div>

          {/* Recording Status */}
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <p className="text-sm text-gray-500">Enregistrement</p>
            <p className="text-lg font-semibold text-gray-900">
              {meeting.recording ? (
                <span className={meeting.recording.status === 'COMPLETED' ? 'text-green-600' : 'text-yellow-600'}>
                  {meeting.recording.status === 'COMPLETED' ? 'Disponible' : 'En cours...'}
                </span>
              ) : (
                <span className="text-gray-400">Non disponible</span>
              )}
            </p>
            {meeting.recording?.fileSize && (
              <p className="text-xs text-gray-400 mt-1">
                {formatFileSize(meeting.recording.fileSize)}
              </p>
            )}
          </div>

          {/* Transcript Status */}
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <p className="text-sm text-gray-500">Transcription</p>
            <p className="text-lg font-semibold text-gray-900">
              {meeting.transcript ? (
                <span className={meeting.transcript.status === 'COMPLETED' ? 'text-green-600' : 'text-yellow-600'}>
                  {meeting.transcript.status === 'COMPLETED'
                    ? `${meeting.transcript.wordCount || 0} mots`
                    : 'En cours...'}
                </span>
              ) : (
                <span className="text-gray-400">Non disponible</span>
              )}
            </p>
            {meeting.transcript?.language && (
              <p className="text-xs text-gray-400 mt-1">
                Langue: {meeting.transcript.language}
              </p>
            )}
          </div>
        </div>

        {/* Recording Player */}
        {meeting.recording?.videoUrl && (
          <div className="bg-white rounded-lg shadow-sm border p-4 mb-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Enregistrement</h2>
            <div className="aspect-video bg-black rounded-lg overflow-hidden">
              <video
                controls
                className="w-full h-full"
                src={meeting.recording.videoUrl}
              >
                Votre navigateur ne supporte pas la lecture vidéo.
              </video>
            </div>
            {meeting.recording.audioUrl && (
              <div className="mt-4">
                <p className="text-sm text-gray-500 mb-2">Audio uniquement:</p>
                <audio controls className="w-full" src={meeting.recording.audioUrl}>
                  Votre navigateur ne supporte pas la lecture audio.
                </audio>
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="bg-white rounded-lg shadow-sm border">
          <div className="border-b">
            <nav className="flex -mb-px">
              <button
                onClick={() => setActiveTab('transcript')}
                className={`px-6 py-3 text-sm font-medium border-b-2 ${
                  activeTab === 'transcript'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Transcription
              </button>
              <button
                onClick={() => setActiveTab('summary')}
                className={`px-6 py-3 text-sm font-medium border-b-2 ${
                  activeTab === 'summary'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Résumé
              </button>
              <button
                onClick={() => setActiveTab('participants')}
                className={`px-6 py-3 text-sm font-medium border-b-2 ${
                  activeTab === 'participants'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Participants ({meeting.participants?.length || 0})
              </button>
              <button
                onClick={() => setActiveTab('chat')}
                className={`px-6 py-3 text-sm font-medium border-b-2 ${
                  activeTab === 'chat'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Chat
              </button>
              <button
                onClick={() => setActiveTab('bot-activity')}
                className={`px-6 py-3 text-sm font-medium border-b-2 ${
                  activeTab === 'bot-activity'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Bot Activity {botLogs.length > 0 && `(${botLogs.length})`}
              </button>
            </nav>
          </div>

          <div className="p-6">
            {/* Transcript Tab */}
            {activeTab === 'transcript' && (
              <div>
                {meeting.transcript?.status === 'COMPLETED' && meeting.transcript.segments?.length > 0 ? (
                  <>
                    {/* Search */}
                    <div className="mb-4">
                      <input
                        type="text"
                        placeholder="Rechercher dans la transcription..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    {/* Full Text Toggle */}
                    <details className="mb-4">
                      <summary className="cursor-pointer text-sm text-blue-600 hover:underline">
                        Voir le texte complet
                      </summary>
                      <div className="mt-2 p-4 bg-gray-50 rounded-lg text-sm text-gray-700 whitespace-pre-wrap">
                        {meeting.transcript.fullText || 'Texte complet non disponible'}
                      </div>
                    </details>

                    {/* Segments */}
                    <div className="space-y-3 max-h-[600px] overflow-y-auto">
                      {filteredSegments.map((segment) => (
                        <div
                          key={segment.id}
                          className={`p-3 rounded-lg border ${
                            segment.speaker
                              ? speakerColorMap.get(segment.speaker.id) || 'bg-gray-50 border-gray-200'
                              : 'bg-gray-50 border-gray-200'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs text-gray-400 font-mono">
                              {formatTimestamp(segment.startTime)}
                            </span>
                            {segment.speaker && (
                              <span className="text-xs font-medium text-gray-600">
                                {segment.speaker.identifiedName || segment.speaker.label}
                              </span>
                            )}
                            {segment.confidence && (
                              <span className="text-xs text-gray-400">
                                ({Math.round(segment.confidence * 100)}%)
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-800">{segment.text}</p>
                        </div>
                      ))}
                    </div>

                    {filteredSegments.length === 0 && searchQuery && (
                      <p className="text-center text-gray-500 py-8">
                        Aucun résultat pour "{searchQuery}"
                      </p>
                    )}
                  </>
                ) : meeting.transcript?.status === 'PROCESSING' ? (
                  <div className="text-center py-12">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                    <p className="mt-4 text-gray-600">Transcription en cours...</p>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500">
                    <p>Aucune transcription disponible</p>
                    <p className="text-sm mt-2">
                      La transcription sera disponible une fois l'enregistrement terminé.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Summary Tab */}
            {activeTab === 'summary' && (
              <div>
                {meeting.summary?.status === 'COMPLETED' ? (
                  <div className="space-y-6">
                    {/* Overview */}
                    {meeting.summary.overview && (
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900 mb-2">Aperçu</h3>
                        <p className="text-gray-700">{meeting.summary.overview}</p>
                      </div>
                    )}

                    {/* Key Points */}
                    {meeting.summary.keyPoints && meeting.summary.keyPoints.length > 0 && (
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900 mb-2">Points clés</h3>
                        <ul className="list-disc list-inside space-y-1">
                          {meeting.summary.keyPoints.map((point, index) => (
                            <li key={index} className="text-gray-700">{point}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Decisions */}
                    {meeting.summary.decisions && meeting.summary.decisions.length > 0 && (
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900 mb-2">Décisions prises</h3>
                        <ul className="list-disc list-inside space-y-1">
                          {meeting.summary.decisions.map((decision, index) => (
                            <li key={index} className="text-gray-700">{decision}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Action Items */}
                    {meeting.summary.actionItems && meeting.summary.actionItems.length > 0 && (
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900 mb-2">Actions à faire</h3>
                        <div className="space-y-2">
                          {meeting.summary.actionItems.map((item, index) => (
                            <div
                              key={index}
                              className="flex items-start gap-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg"
                            >
                              <input type="checkbox" className="mt-1" />
                              <div>
                                <p className="text-gray-800">{item.task}</p>
                                {(item.assignee || item.dueDate) && (
                                  <p className="text-sm text-gray-500 mt-1">
                                    {item.assignee && <span>Assigné à: {item.assignee}</span>}
                                    {item.assignee && item.dueDate && ' - '}
                                    {item.dueDate && <span>Échéance: {item.dueDate}</span>}
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Next Steps */}
                    {meeting.summary.nextSteps && (
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900 mb-2">Prochaines étapes</h3>
                        <p className="text-gray-700">{meeting.summary.nextSteps}</p>
                      </div>
                    )}
                  </div>
                ) : meeting.summary?.status === 'PROCESSING' ? (
                  <div className="text-center py-12">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                    <p className="mt-4 text-gray-600">Génération du résumé en cours...</p>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500">
                    <p>Aucun résumé disponible</p>
                    <p className="text-sm mt-2">
                      Le résumé sera généré automatiquement après la transcription.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Participants Tab */}
            {activeTab === 'participants' && (
              <div>
                {meeting.participants && meeting.participants.length > 0 ? (
                  <div className="space-y-2">
                    {meeting.participants.map((participant) => (
                      <div
                        key={participant.id}
                        className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                            <span className="text-blue-600 font-medium">
                              {participant.name.charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">
                              {participant.name}
                              {participant.isHost && (
                                <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                                  Hôte
                                </span>
                              )}
                            </p>
                            {participant.email && (
                              <p className="text-sm text-gray-500">{participant.email}</p>
                            )}
                          </div>
                        </div>
                        {participant.joinedAt && (
                          <div className="text-right text-sm text-gray-500">
                            <p>Arrivé: {new Date(participant.joinedAt).toLocaleTimeString('fr-FR')}</p>
                            {participant.leftAt && (
                              <p>Parti: {new Date(participant.leftAt).toLocaleTimeString('fr-FR')}</p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500">
                    <p>Aucun participant enregistré</p>
                  </div>
                )}
              </div>
            )}

            {/* Chat Tab */}
            {activeTab === 'chat' && (
              <div className="text-center py-12">
                <Link
                  href={`/dashboard/meetings/${meeting.id}/chat`}
                  className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Voir le chat complet
                </Link>
                <p className="text-sm text-gray-500 mt-4">
                  Les messages de chat sont disponibles sur la page dediee.
                </p>
              </div>
            )}

            {/* Bot Activity Tab */}
            {activeTab === 'bot-activity' && (
              <div className="flex flex-col lg:flex-row gap-0 divide-y lg:divide-y-0 lg:divide-x">
                {/* Screenshots Panel */}
                <div className="lg:w-1/2 p-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Screenshots</h3>
                  {selectedScreenshot ? (
                    <div className="mb-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={selectedScreenshot}
                        alt="Bot screenshot"
                        className="w-full rounded border border-gray-200"
                      />
                    </div>
                  ) : (
                    <div className="bg-gray-100 rounded border border-gray-200 flex items-center justify-center h-48 mb-3">
                      <p className="text-gray-400 text-sm">Aucun screenshot</p>
                    </div>
                  )}
                  {/* Screenshot thumbnails */}
                  <div className="flex gap-1.5 overflow-x-auto pb-2">
                    {botScreenshots.map((s) => (
                      <button
                        key={s.filename}
                        onClick={() => setSelectedScreenshot(s.url)}
                        className={`flex-shrink-0 w-20 h-12 rounded border overflow-hidden ${
                          selectedScreenshot === s.url
                            ? 'border-blue-500 ring-2 ring-blue-200'
                            : 'border-gray-200 hover:border-gray-400'
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={s.url} alt={s.step} className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                  {botScreenshots.length > 0 && (
                    <p className="text-xs text-gray-400 mt-2">
                      {botScreenshots[botScreenshots.length - 1]?.step?.replace(/_/g, ' ')}
                    </p>
                  )}
                </div>

                {/* Logs Panel */}
                <div className="lg:w-1/2 p-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">
                    Logs {botLogs.length > 0 && <span className="text-gray-400 font-normal">({botLogs.length})</span>}
                  </h3>
                  <div className="max-h-[500px] overflow-y-auto space-y-1 font-mono text-xs">
                    {botLogs.length === 0 ? (
                      <p className="text-gray-400 text-center py-8">Aucun log</p>
                    ) : (
                      [...botLogs].reverse().map((log) => (
                        <div
                          key={log.id}
                          className={`flex gap-2 px-2 py-1 rounded ${
                            log.level === 'ERROR'
                              ? 'bg-red-50 text-red-800'
                              : log.level === 'WARN'
                              ? 'bg-yellow-50 text-yellow-800'
                              : 'bg-gray-50 text-gray-700'
                          }`}
                        >
                          <span className="text-gray-400 flex-shrink-0">
                            {new Date(log.createdAt).toLocaleTimeString('fr-FR')}
                          </span>
                          <span
                            className={`flex-shrink-0 w-12 text-center rounded px-1 ${
                              log.level === 'ERROR'
                                ? 'bg-red-200 text-red-700'
                                : log.level === 'WARN'
                                ? 'bg-yellow-200 text-yellow-700'
                                : log.level === 'INFO'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-gray-200 text-gray-600'
                            }`}
                          >
                            {log.level}
                          </span>
                          <span className="break-all">{log.message}</span>
                          {log.metadata && (
                            <details className="ml-auto flex-shrink-0">
                              <summary className="cursor-pointer text-gray-400 hover:text-gray-600">...</summary>
                              <pre className="mt-1 text-[10px] bg-gray-100 p-1 rounded max-w-xs overflow-auto">
                                {JSON.stringify(log.metadata, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
