import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./router";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n";
import { SettingsProvider } from "./settings/SettingsContext";
import { ResultsProvider } from "./results/ResultsContext";
import { StatsProvider } from "./stats/StatsContext";

function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <SettingsProvider>
        <StatsProvider>
          <ResultsProvider>
            <BrowserRouter basename={__BASE_PATH__}>
              <AppRoutes />
            </BrowserRouter>
          </ResultsProvider>
        </StatsProvider>
      </SettingsProvider>
    </I18nextProvider>
  );
}

export default App;
