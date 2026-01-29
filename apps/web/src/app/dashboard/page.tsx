'use client';

import { useState } from 'react';

export default function Dashboard() {
  const [meetingUrl, setMeetingUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New Meeting',
          meetingUrl,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create meeting');
      }

      setMeetingUrl('');
      // Refresh meetings list
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Manage your meeting recordings
          </p>
        </header>

        {/* New Meeting Form */}
        <section className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-gray-700 mb-8">
          <h2 className="text-xl font-semibold mb-4">Record a Meeting</h2>
          <form onSubmit={handleSubmit} className="flex gap-4">
            <input
              type="url"
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              placeholder="Paste meeting URL (Zoom, Teams, or Google Meet)"
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              required
            />
            <button
              type="submit"
              disabled={isLoading}
              className="bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white px-6 py-2 rounded-lg font-medium transition-colors"
            >
              {isLoading ? 'Starting...' : 'Start Recording'}
            </button>
          </form>
          {error && (
            <p className="text-red-500 mt-2 text-sm">{error}</p>
          )}
        </section>

        {/* Meetings List */}
        <section>
          <h2 className="text-xl font-semibold mb-4">Recent Meetings</h2>
          <MeetingsList />
        </section>
      </div>
    </main>
  );
}

function MeetingsList() {
  // This will be populated from the API
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="p-8 text-center text-gray-500">
        <p>No meetings yet. Paste a meeting URL above to get started.</p>
      </div>
    </div>
  );
}
