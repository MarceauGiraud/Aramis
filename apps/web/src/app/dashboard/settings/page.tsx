'use client';

import Link from 'next/link';

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard/meetings"
              className="text-gray-500 hover:text-gray-700"
            >
              &larr; Retour
            </Link>
            <h1 className="text-xl font-semibold text-gray-900">
              Parametres
            </h1>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* User Info */}
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Informations utilisateur
          </h2>
          <div className="space-y-3">
            <div>
              <label className="text-sm text-gray-500">Identifiant</label>
              <p className="text-gray-900">demo-user</p>
            </div>
            <p className="text-sm text-gray-500">
              L'authentification est geree par le SaaS parent.
            </p>
          </div>
        </div>

        {/* API Keys Section */}
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Cles API
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Gerez vos cles API pour acceder a l'API Aramis.
          </p>
          <div className="text-center py-8 text-gray-400">
            <p>Bientot disponible</p>
          </div>
        </div>

        {/* Billing Section */}
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Facturation
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Consultez votre solde de credits et votre historique.
          </p>
          <div className="text-center py-8 text-gray-400">
            <p>Bientot disponible</p>
          </div>
        </div>

        {/* Integrations Section */}
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Integrations
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Connectez vos calendriers et services externes.
          </p>
          <div className="text-center py-8 text-gray-400">
            <p>Bientot disponible</p>
          </div>
        </div>
      </main>
    </div>
  );
}
