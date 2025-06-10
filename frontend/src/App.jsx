import { Button } from "@/components/ui/button";
import './App.css'; // Or remove if not using App.css specifically

function App() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4">
      <header className="mb-8">
        <h1 className="text-4xl font-bold text-primary">New Agent Interface</h1>
      </header>
      <main className="mb-8">
        <p className="text-muted-foreground mb-4">This is the new UI, powered by React, Vite, Tailwind, and Shadcn/UI.</p>
        <Button variant="outline">Test Shadcn/UI Button</Button>
      </main>
      <footer className="text-sm text-muted-foreground">
        <p>© 2024 AI Agent Project</p>
      </footer>
    </div>
  );
}
export default App;
