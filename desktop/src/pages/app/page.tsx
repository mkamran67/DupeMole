import { useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ScanView from './components/ScanView';
import ResultsView from './components/ResultsView';
import OrganizeView from './components/OrganizeView';
import SettingsView from './components/SettingsView';
import CompareView from './components/CompareView';
import AboutView from './components/AboutView';
import StatsFooter from './components/StatsFooter';

export default function AppPage() {
  const [activeTab, setActiveTab] = useState('scan');
  const [visited, setVisited] = useState<Set<string>>(() => new Set(['scan']));
  const { groupId } = useParams();

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, []);

  const handleNavigateToResults = useCallback(() => {
    handleTabChange('results');
  }, [handleTabChange]);

  const handleNavigateToScan = useCallback(() => {
    handleTabChange('scan');
  }, [handleTabChange]);

  const views: { id: string; node: React.ReactNode }[] = [
    { id: 'scan', node: <ScanView onNavigateToResults={handleNavigateToResults} /> },
    { id: 'results', node: <ResultsView onNavigateToScan={handleNavigateToScan} /> },
    { id: 'organize', node: <OrganizeView /> },
    { id: 'settings', node: <SettingsView /> },
    { id: 'about', node: <AboutView /> },
  ];

  return (
    <div className="h-screen w-full flex bg-[#1f1008] overflow-hidden">
      <Sidebar activeTab={activeTab} onTabChange={handleTabChange} />
      <main className="flex-1 overflow-y-auto p-5 md:p-8 pb-10 md:pb-16">
        {groupId ? (
          <CompareView />
        ) : (
          <>
            {views.map(({ id, node }) =>
              visited.has(id) ? (
                <div
                  key={id}
                  className="h-full"
                  style={{ display: activeTab === id ? undefined : 'none' }}
                >
                  {node}
                </div>
              ) : null,
            )}
            {activeTab === 'scan' && <StatsFooter />}
          </>
        )}
      </main>
    </div>
  );
}
