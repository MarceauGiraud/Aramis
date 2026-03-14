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

interface SpeakingStat {
  name: string;
  duration: number;
  percentage: number;
  segmentCount: number;
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
  speakingStats?: SpeakingStat[];
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
  const [activeTab, setActiveTab] = useState<'transcript' | 'summary' | 'participants'>('transcript');
  const [searchQuery, setSearchQuery] = useState('');

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
                {/* Speaking Stats */}
                {meeting.speakingStats && meeting.speakingStats.length > 0 && (
                  <div className="mb-6">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">
                      Temps de parole
                    </h3>
                    <div className="space-y-3">
                      {meeting.speakingStats
                        .sort((a, b) => b.percentage - a.percentage)
                        .map((stat, index) => (
                          <div key={index} className="flex items-center gap-3">
                            <div className="w-32 text-sm text-gray-700 truncate font-medium">
                              {stat.name}
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 bg-gray-200 rounded-full h-4 overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${
                                      [
                                        'bg-blue-500',
                                        'bg-green-500',
                                        'bg-purple-500',
                                        'bg-orange-500',
                                        'bg-pink-500',
                                        'bg-cyan-500',
                                      ][index % 6]
                                    }`}
                                    style={{ width: `${stat.percentage}%` }}
                                  />
                                </div>
                                <span className="text-sm text-gray-600 w-12 text-right">
                                  {stat.percentage}%
                                </span>
                              </div>
                            </div>
                            <div className="text-xs text-gray-400 w-24 text-right">
                              {formatDuration(stat.duration)} ({stat.segmentCount} seg.)
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {/* Participant List */}
                {meeting.participants && meeting.participants.length > 0 ? (
                  <div className="space-y-2">
                    {meeting.speakingStats && meeting.speakingStats.length > 0 && (
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Participants
                      </h3>
                    )}
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
                ) : !meeting.speakingStats?.length ? (
                  <div className="text-center py-12 text-gray-500">
                    <p>Aucun participant enregistré</p>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
