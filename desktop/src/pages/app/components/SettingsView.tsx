import { useSettings, type AppSettings, type ScanThreads } from '../../../settings/SettingsContext';

interface SettingItem {
  id: string;
  icon: string;
  title: string;
  description: string;
  type: 'toggle' | 'dropdown';
  options?: string[];
  default: boolean | string;
}

const settings: SettingItem[] = [
  {
    id: 'confirm-delete',
    icon: 'ri-shield-check-line',
    title: 'Confirm Deletion',
    description: 'Show a confirmation dialog before removing files',
    type: 'toggle',
    default: true,
  },
  {
    id: 'move-to-trash',
    icon: 'ri-delete-bin-line',
    title: 'Move to Trash',
    description: 'Send duplicates to trash instead of permanently deleting',
    type: 'toggle',
    default: true,
  },
  {
    id: 'scan-threads',
    icon: 'ri-cpu-line',
    title: 'Scan Threads',
    description: 'Number of parallel threads for scanning',
    type: 'dropdown',
    options: ['2', '4', '6', '8', 'Auto'],
    default: 'Auto',
  },
  {
    id: 'notifications',
    icon: 'ri-notification-line',
    title: 'Notifications',
    description: 'Show desktop notifications when scan completes',
    type: 'toggle',
    default: true,
  },
  {
    id: 'ignore-hidden',
    icon: 'ri-eye-off-line',
    title: 'Ignore Hidden Files',
    description: 'Skip files starting with a dot during scan',
    type: 'toggle',
    default: false,
  },
  {
    id: 'auto-scan',
    icon: 'ri-refresh-line',
    title: 'Auto Scan on Launch',
    description: 'Automatically scan last used directories on startup',
    type: 'toggle',
    default: false,
  },
  {
    id: 'use-metadata-dates',
    icon: 'ri-camera-lens-line',
    title: 'Read Photo & Video Dates',
    description:
      'Use EXIF / video metadata for the original capture date instead of file modified time. Slower but more accurate.',
    type: 'toggle',
    default: false,
  },
  {
    id: 'minimize-tray',
    icon: 'ri-indeterminate-circle-line',
    title: 'Minimize to Tray',
    description: 'Keep running in system tray when window is closed',
    type: 'toggle',
    default: true,
  },
  {
    id: 'language',
    icon: 'ri-global-line',
    title: 'Language',
    description: 'Interface language for the application',
    type: 'dropdown',
    options: ['English', 'Spanish', 'French', 'German', 'Japanese'],
    default: 'English',
  },
];

const idToKey: Record<string, keyof AppSettings> = {
  'confirm-delete': 'confirmDelete',
  'move-to-trash': 'moveToTrash',
  'scan-threads': 'scanThreads',
  'notifications': 'notifications',
  'ignore-hidden': 'ignoreHidden',
  'auto-scan': 'autoScan',
  'minimize-tray': 'minimizeTray',
  'language': 'language',
  'use-metadata-dates': 'useMetadataDates',
};

function scanThreadsToString(v: ScanThreads): string {
  return v === 'Auto' ? 'Auto' : String(v.N);
}

function stringToScanThreads(s: string): ScanThreads {
  return s === 'Auto' ? 'Auto' : { N: parseInt(s, 10) };
}

export default function SettingsView() {
  const { settings: values, updateSettings } = useSettings();

  const readValue = (id: string): boolean | string => {
    const key = idToKey[id];
    const raw = values[key];
    if (key === 'scanThreads') return scanThreadsToString(raw as ScanThreads);
    return raw as boolean | string;
  };

  const toggleValue = (id: string) => {
    const key = idToKey[id];
    updateSettings({ [key]: !values[key] } as Partial<AppSettings>);
  };

  const setDropdown = (id: string, val: string) => {
    const key = idToKey[id];
    const next = key === 'scanThreads' ? stringToScanThreads(val) : val;
    updateSettings({ [key]: next } as Partial<AppSettings>);
  };

  return (
    <div className="min-h-full flex flex-col pb-8">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-white text-2xl font-bold tracking-tight">Settings</h2>
        <p className="text-white/40 text-sm mt-1">Fine-tune your DupeMole experience</p>
      </div>

      <div className="pr-1 -mr-1">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {settings.map((setting) => (
            <div
              key={setting.id}
              className="bg-[#3d2418] rounded-2xl p-5 border border-white/10 hover:border-[#f5c542]/20 transition-colors duration-300"
            >
              <div className="w-11 h-11 rounded-xl bg-[#f5c542]/10 flex items-center justify-center mb-4">
                <i className={`${setting.icon} text-[#f5c542] text-lg`}></i>
              </div>

              <h3 className="text-white font-semibold text-sm">{setting.title}</h3>
              <p className="text-white/35 text-xs mt-1.5 leading-relaxed">{setting.description}</p>

              <div className="mt-4">
                {setting.type === 'toggle' ? (
                  <button
                    onClick={() => toggleValue(setting.id)}
                    className={`relative w-12 h-7 rounded-full transition-colors duration-300 cursor-pointer ${
                      readValue(setting.id) ? 'bg-[#f5c542]' : 'bg-white/10'
                    }`}
                  >
                    <div
                      className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-300 ${
                        readValue(setting.id) ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                ) : (
                  <div className="relative">
                    <select
                      value={readValue(setting.id) as string}
                      onChange={(e) => setDropdown(setting.id, e.target.value)}
                      className="w-full text-sm px-3 py-2.5 rounded-lg border border-white/10 bg-white/5 text-white focus:outline-none focus:border-[#f5c542]/40 transition-colors duration-200 appearance-none cursor-pointer"
                    >
                      {setting.options?.map((opt) => (
                        <option key={opt} value={opt} className="bg-[#3d2418]">
                          {opt}
                        </option>
                      ))}
                    </select>
                    <i className="ri-arrow-down-s-line absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-sm pointer-events-none"></i>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* App Info */}
        <div className="mt-6 bg-[#3d2418] rounded-2xl border border-white/10 p-5 flex items-center justify-between">
          <div>
            <p className="text-white text-sm font-medium">DupeMole</p>
            <p className="text-white/30 text-xs mt-0.5">Version 1.0.0 &bull; macOS & Linux</p>
          </div>
          <button className="text-xs font-medium text-[#f5c542] hover:text-[#e0b038] transition-colors duration-200 cursor-pointer whitespace-nowrap">
            Check for Updates
          </button>
        </div>
      </div>
    </div>
  );
}
