import { useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ScanView from './components/ScanView';
import ResultsView from './components/ResultsView';
import FiltersView from './components/FiltersView';
import SettingsView from './components/SettingsView';
import CompareView from './components/CompareView';
import AboutView from './components/AboutView';
import StatsFooter from './components/StatsFooter';

export default function AppPage() {
  const [activeTab, setActiveTab] = useState('scan');
  const { groupId } = useParams();

  const handleNavigateToResults = useCallback(() => {
    setActiveTab('results');
  }, []);

  const handleNavigateToScan = useCallback(() => {
    setActiveTab('scan');
  }, []);

  const views: Record<string, React.ReactNode> = {
    scan: <ScanView onNavigateToResults={handleNavigateToResults} />,
    results: <ResultsView onNavigateToScan={handleNavigateToScan} />,
    filters: <FiltersView />,
    settings: <SettingsView />,
    about: <AboutView />,
  };

  return (
    <div className="h-screen w-full flex bg-[#1f1008] overflow-hidden">
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} />
      <main className="flex-1 overflow-y-auto p-5 md:p-8 pb-10 md:pb-16">
        {groupId ? <CompareView /> : views[activeTab]}
        {!groupId && activeTab === 'scan' && <StatsFooter />}
      </main>
    </div>
  );
}