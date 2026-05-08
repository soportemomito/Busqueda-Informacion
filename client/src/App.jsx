import { Routes, Route, NavLink } from 'react-router-dom';
import SearchPage from './pages/SearchPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import { isDashboardEmbed } from './hooks/useChatwootDashboardContext.js';

export default function App() {
  const embed = isDashboardEmbed();

  return (
    <div className="min-h-screen flex flex-col">
      {!embed && (
        <header className="border-b border-momo-200 bg-white/90 backdrop-blur sticky top-0 z-20">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-momo-600 text-white flex items-center justify-center text-sm font-bold shadow-sm">
                ST
              </div>
              <div>
                <h1 className="text-base font-semibold text-momo-900 leading-tight">SoyMomo Info</h1>
                <p className="text-xs text-momo-500">Vista 360° · Chatwoot · Bsale · Shopify · Drive</p>
              </div>
            </div>
            <nav className="flex gap-1 text-sm">
              <NavLink
                to="/"
                end
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md font-medium transition-colors ${
                    isActive ? 'bg-momo-100 text-momo-800' : 'text-momo-600 hover:bg-momo-50'
                  }`
                }
              >
                Buscar
              </NavLink>
              <NavLink
                to="/settings"
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md font-medium transition-colors ${
                    isActive ? 'bg-momo-100 text-momo-800' : 'text-momo-600 hover:bg-momo-50'
                  }`
                }
              >
                Configuración
              </NavLink>
            </nav>
          </div>
        </header>
      )}
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
