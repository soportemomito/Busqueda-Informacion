import { Routes, Route } from 'react-router-dom';
import SearchPage from './pages/SearchPage.jsx';
import { isDashboardEmbed } from './hooks/useChatwootDashboardContext.js';

export default function App() {
  const embed = isDashboardEmbed();

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {!embed && (
        <header className="border-b border-slate-200 bg-white sticky top-0 z-20 shadow-sm">
          <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-momo-600 text-white flex items-center justify-center text-sm font-black shadow-sm">
              SM
            </div>
            <div>
              <h1 className="text-sm font-bold text-slate-800 leading-tight">SoyMomo Info</h1>
              <p className="text-[11px] text-slate-400">Chatwoot · Bsale · Shopify · Drive</p>
            </div>
          </div>
        </header>
      )}
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="*" element={<SearchPage />} />
        </Routes>
      </main>
    </div>
  );
}
