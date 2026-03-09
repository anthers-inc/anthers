import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import FormField from "../components/ui/FormField";

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setLoading(true);
    try {
      await register(username, email, password, passwordConfirm);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        const data = err.data as Record<string, string[]>;
        const fieldErrors: Record<string, string> = {};
        for (const [key, messages] of Object.entries(data)) {
          if (Array.isArray(messages)) {
            fieldErrors[key] = messages[0];
          }
        }
        if (data?.non_field_errors) {
          fieldErrors.general = data.non_field_errors[0];
        }
        setErrors(fieldErrors);
      } else {
        setErrors({ general: "Something went wrong. Please try again." });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-md">
      <div className="card bg-base-200 shadow-lg">
        <div className="card-body">
          <h1 className="card-title text-2xl justify-center">Create account</h1>
          {errors.general && (
            <div className="alert alert-error text-sm">
              <span>{errors.general}</span>
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <FormField label="Username" required error={errors.username}>
              <input
                type="text"
                className="input input-bordered w-full"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
              />
            </FormField>
            <FormField label="Email" required error={errors.email}>
              <input
                type="email"
                className="input input-bordered w-full"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </FormField>
            <FormField label="Password" required error={errors.password}>
              <input
                type="password"
                className="input input-bordered w-full"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </FormField>
            <FormField label="Confirm password" required error={errors.password_confirm}>
              <input
                type="password"
                className="input input-bordered w-full"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                required
              />
            </FormField>
            <button
              type="submit"
              className="btn btn-primary w-full mt-2"
              disabled={loading}
            >
              {loading ? <span className="loading loading-spinner loading-sm" /> : "Sign up"}
            </button>
          </form>
          <p className="text-center text-sm mt-4">
            Already have an account?{" "}
            <Link to="/login" className="link link-primary">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
