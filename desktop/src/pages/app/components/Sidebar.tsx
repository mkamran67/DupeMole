import { Link, useNavigate } from 'react-router-dom';

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

const tabs = [
  { id: 'scan', icon: 'ri-search-line', label: 'Scan' },
  { id: 'results', icon: 'ri-folders-line', label: 'Results' },
  { id: 'filters', icon: 'ri-filter-3-line', label: 'Filters' },
  { id: 'settings', icon: 'ri-settings-3-line', label: 'Settings' },
];

export default function Sidebar({ activeTab, onTabChange }: SidebarProps) {
  const navigate = useNavigate();

  return (
    <aside className="w-16 lg:w-56 h-full flex flex-col bg-[#2c1810] border-r border-white/10 shrink-0">
      {/* App Header */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-white/10">
        <img
          src="https://readdy.ai/api/search-image?query=A%20modern%20minimalist%20app%20icon%20logo%20featuring%20two%20overlapping%20rounded%20squares%2C%20one%20dark%20charcoal%20and%20one%20warm%20golden%20yellow%2C%20with%20a%20cute%20stylized%20dark%20brown%20mole%20silhouette%20peeking%20out%20inside%20the%20golden%20square%2C%20a%20single%20bright%20yellow%20eye%20dot%2C%20clean%20flat%20vector%20design%20style%2C%20transparent%20background%2C%20high%20resolution%20crisp%20edges%2C%20professional%20app%20icon%20design&width=512&height=512&seq=dupemole-logo-1&orientation=squarish"
          alt="DupeMole"
          className="w-8 h-8 rounded-lg object-cover bg-[#faf6f1]"
        />
        <span className="font-bold text-white text-sm tracking-tight hidden lg:block">DupeMole</span>
      </div>

      {/* Nav Tabs */}
      <nav className="flex-1 px-2 py-4 space-y-1">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => {
                navigate('/app');
                onTabChange(tab.id);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer ${
                isActive
                  ? 'bg-[#f5c542]/15 text-[#f5c542]'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/5'
              }`}
            >
              <div className="w-8 h-8 flex items-center justify-center">
                <i className={`${tab.icon} text-lg`}></i>
              </div>
              <span className="hidden lg:block whitespace-nowrap">{tab.label}</span>
              {isActive && (
                <div className="hidden lg:block ml-auto w-1.5 h-1.5 rounded-full bg-[#f5c542]" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="p-2 border-t border-white/10">
        <Link
          to="/"
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-white/40 hover:text-white/70 hover:bg-white/5 transition-all duration-200 cursor-pointer"
        >
          <div className="w-8 h-8 flex items-center justify-center">
            <i className="ri-arrow-left-line text-lg"></i>
          </div>
          <span className="hidden lg:block whitespace-nowrap">Back to Home</span>
        </Link>
      </div>
    </aside>
  );
}
