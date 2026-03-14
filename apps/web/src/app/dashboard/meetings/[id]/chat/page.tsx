'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface ChatMessage {
  id: string;
  sender: string;
  message: string;
  timestamp: string;
  platform?: string;
}

interface PaginatedResponse {
  data: ChatMessage[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function ChatPage() {
  const params = useParams();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meetingStatus, setMeetingStatus] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchMessages = async () => {
    try {
      const response = await fetch(`/api/bots/${params.id}/chat?limit=100`);
      if (!response.ok) {
        if (response.status === 404) {
          setError('Meeting non trouve');
          return;
        }
        setError('Erreur lors du chargement des messages');
        return;
      }
      const data: PaginatedResponse = await response.json();
      setMessages(data.data);
    } catch {
      setError('Erreur de connexion');
    } finally {
      setLoading(false);
    }
  };

  const fetchMeetingStatus = async () => {
    try {
      const response = await fetch(`/api/bots/${params.id}`);
      if (response.ok) {
        const data = await response.json();
        setMeetingStatus(data.status);
      }
    } catch {
      // Ignore status fetch errors
    }
  };

  useEffect(() => {
    if (params.id) {
      fetchMessages();
      fetchMeetingStatus();
    }
  }, [params.id]);

  // Auto-refresh if meeting is active
  useEffect(() => {
    if (
      meetingStatus === 'RECORDING' ||
      meetingStatus === 'JOINING' ||
      meetingStatus === 'WAITING'
    ) {
      const interval = setInterval(() => {
        fetchMessages();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [meetingStatus, params.id]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 text-lg">{error}</p>
          <Link
            href={`/dashboard/meetings/${params.id}`}
            className="mt-4 inline-block text-blue-600 hover:underline"
          >
            Retour au meeting
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link
              href={`/dashboard/meetings/${params.id}`}
              className="text-gray-500 hover:text-gray-700"
            >
              &larr; Retour
            </Link>
            <h1 className="text-xl font-semibold text-gray-900">
              Chat du meeting
            </h1>
            {meetingStatus === 'RECORDING' && (
              <span className="px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800">
                En direct
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="bg-white rounded-lg shadow-sm border">
          {messages.length > 0 ? (
            <div className="p-4 space-y-3 max-h-[600px] overflow-y-auto">
              {messages.map((msg) => (
                <div key={msg.id} className="flex gap-3">
                  <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-blue-600 text-sm font-medium">
                      {msg.sender.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-900">
                        {msg.sender}
                      </span>
                      <span className="text-xs text-gray-400">
                        {formatTime(msg.timestamp)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-700">{msg.message}</p>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500">
              <p>Aucun message de chat</p>
              <p className="text-sm mt-2">
                Les messages de chat apparaitront ici une fois captures.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
