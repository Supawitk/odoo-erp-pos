import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Loader2, UserPlus } from "lucide-react";
import { API_BASE } from "~/lib/api";
import { useAuth, type AuthUser } from "~/lib/auth";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!username && !email) {
      setErr("Provide a username, an email, or both");
      return;
    }
    if (username && !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      setErr("Username must be 3–32 characters: letters, digits, dot, underscore, dash");
      return;
    }
    if (password !== confirm) {
      setErr("Passwords don't match");
      return;
    }
    if (password.length < 4) {
      setErr("Password must be at least 4 characters");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username || undefined,
          email: email || undefined,
          password,
          name,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message ?? `Registration failed (${res.status})`);
      }
      const d: { accessToken: string; refreshToken: string; user: AuthUser } = await res.json();
      useAuth.getState().setSession(d.accessToken, d.refreshToken, d.user);
      navigate("/", { replace: true });
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            <CardTitle>Create account</CardTitle>
          </div>
          <CardDescription>
            New accounts default to the <b>cashier</b> role. An admin can promote you later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Full name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Username <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="alice"
                pattern="[a-zA-Z0-9._-]{3,32}"
                autoComplete="username"
              />
              <p className="text-[10px] text-muted-foreground">
                3–32 chars · letters, digits, dot, underscore, dash
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Email <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alice@example.com"
                autoComplete="email"
              />
              <p className="text-[10px] text-muted-foreground">
                At least one of <b>username</b> or <b>email</b> is required.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Password</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={4}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Confirm password</label>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            {err && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {err}
              </div>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create account
            </Button>
          </form>
          <div className="mt-4 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
