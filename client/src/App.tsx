import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import LoginPage from "@/pages/login";
import HistoryPage from "@/pages/history";
import CapturePage from "@/pages/capture";
import InvoiceFormPage from "@/pages/invoice-form";
import AdminPage from "@/pages/admin";
import NotFound from "@/pages/not-found";

function AuthenticatedRouter() {
  const { user } = useAuth();

  if (!user) {
    return <LoginPage />;
  }

  return (
    <Switch>
      <Route path="/" component={HistoryPage} />
      <Route path="/capture" component={CapturePage} />
      <Route path="/form" component={InvoiceFormPage} />
      <Route path="/admin" component={AdminPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthProvider>
          <Router hook={useHashLocation}>
            <AuthenticatedRouter />
          </Router>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
