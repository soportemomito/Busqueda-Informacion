import { Routes, Route } from 'react-router-dom';
import SearchPage from './pages/SearchPage.jsx';
import { isDashboardEmbed } from './hooks/useChatwootDashboardContext.js';

export default function App() {
  const embed = isDashboardEmbed();

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {!embed && (
        <header className="border-b border-slate-200/80 bg-white/95 backdrop-blur-md sticky top-0 z-20 shadow-sm">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-momo-700 to-momo-500 text-white flex items-center justify-center text-sm font-bold shadow-md shadow-momo-500/25">
              SM
            </div>
            <div>
              <h1 className="text-sm font-extrabold text-slate-900 leading-tight tracking-tight">SoyMomo <span className="text-momo-600">ST System</span></h1>
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Centro de Inteligencia de Clientes</p>
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
