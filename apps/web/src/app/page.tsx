import Link from 'next/link';

export default function Home() {
  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <header className="mb-12">
          <h1 className="text-4xl font-bold mb-4">Aramis</h1>
          <p className="text-xl text-gray-600 dark:text-gray-300">
            Meeting Recorder for Zoom, Teams, and Google Meet
          </p>
        </header>

        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-4">Features</h2>
          <div className="grid md:grid-cols-3 gap-6">
            <FeatureCard
              title="Multi-Platform"
              description="Works with Zoom, Microsoft Teams, and Google Meet"
              icon="🎯"
            />
            <FeatureCard
              title="Auto Transcription"
              description="AI-powered transcription with speaker identification"
              icon="📝"
            />
            <FeatureCard
              title="Smart Summaries"
              description="Get AI-generated summaries and action items"
              icon="✨"
            />
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-4">Quick Start</h2>
          <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-6">
            <ol className="list-decimal list-inside space-y-3">
              <li>Sign in with your account</li>
              <li>Paste a meeting URL (Zoom, Teams, or Google Meet)</li>
              <li>Click &quot;Record&quot; and the bot will join your meeting</li>
              <li>Get your recording and transcript when the meeting ends</li>
            </ol>
          </div>
        </section>

        <div className="flex gap-4">
          <Link
            href="/dashboard"
            className="bg-primary-600 hover:bg-primary-700 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Go to Dashboard
          </Link>
          <Link
            href="/api/docs"
            className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 px-6 py-3 rounded-lg font-medium transition-colors"
          >
            API Documentation
          </Link>
        </div>
      </div>
    </main>
  );
}

function FeatureCard({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-gray-700">
      <div className="text-3xl mb-3">{icon}</div>
      <h3 className="font-semibold mb-2">{title}</h3>
      <p className="text-gray-600 dark:text-gray-400 text-sm">{description}</p>
    </div>
  );
}
