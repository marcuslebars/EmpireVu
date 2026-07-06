import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, ArrowLeft, Phone } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

type AuthMode = "phone" | "otp";

export default function PhoneAuthPage() {
  const navigate = useNavigate();
  const { signInWithPhone, verifyOtp } = useAuth();
  const [mode, setMode] = useState<AuthMode>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);

  const formatPhone = (value: string) => {
    const digits = value.replace(/\D/g, "");
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
  };

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    const cleanPhone = phone.replace(/\D/g, "");
    if (cleanPhone.length < 10) {
      setError("Please enter a valid phone number");
      setIsLoading(false);
      return;
    }

    const formattedPhone = cleanPhone.startsWith("1") ? `+${cleanPhone}` : `+1${cleanPhone}`;

    const result = await signInWithPhone(formattedPhone);

    if (result.error) {
      setError(result.error);
      setIsLoading(false);
      return;
    }

    setOtpSent(true);
    setMode("otp");
    setIsLoading(false);
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    if (otp.length < 6) {
      setError("Please enter the complete verification code");
      setIsLoading(false);
      return;
    }

    const cleanPhone = phone.replace(/\D/g, "");
    const formattedPhone = cleanPhone.startsWith("1") ? `+${cleanPhone}` : `+1${cleanPhone}`;

    const result = await verifyOtp(formattedPhone, otp);

    if (result.error) {
      setError(result.error);
      setIsLoading(false);
      return;
    }

    setIsLoading(false);
  };

  const handleBack = () => {
    if (mode === "otp") {
      setMode("phone");
      setOtp("");
      setOtpSent(false);
      setError(null);
    } else {
      navigate("/signin");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-[420px]">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20">
            <span className="text-primary-foreground font-bold text-lg">S</span>
          </div>
          <span className="text-2xl font-semibold tracking-tight text-foreground">EmpireVu</span>
        </div>

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-semibold tracking-tight">
              {mode === "phone" ? "Sign in with phone" : "Enter verification code"}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {mode === "phone"
                ? "We'll send you a code via SMS"
                : `Code sent to ${phone}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {error && (
              <Alert variant="destructive" className="py-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {mode === "phone" ? (
              <form onSubmit={handlePhoneSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="phone" className="text-sm font-medium">Phone Number</Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="phone"
                      type="tel"
                      placeholder="(555) 123-4567"
                      value={phone}
                      onChange={(e) => setPhone(formatPhone(e.target.value))}
                      required
                      disabled={isLoading}
                      autoComplete="tel"
                      className="pl-10 h-11"
                    />
                  </div>
                </div>

                <Button type="submit" className="w-full h-11 text-base font-medium" disabled={isLoading}>
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending code...
                    </>
                  ) : (
                    "Send verification code"
                  )}
                </Button>
              </form>
            ) : (
              <form onSubmit={handleOtpSubmit} className="space-y-4">
                <div className="space-y-3">
                  <Label htmlFor="otp" className="text-sm font-medium">Verification Code</Label>
                  <Input
                    id="otp"
                    type="text"
                    inputMode="numeric"
                    placeholder="000000"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    required
                    disabled={isLoading}
                    autoComplete="one-time-code"
                    className="text-center text-2xl tracking-[0.5em] font-mono h-14"
                    maxLength={6}
                  />
                  <p className="text-xs text-muted-foreground text-center">
                    Enter the 6-digit code sent to your phone
                  </p>
                </div>

                <Button type="submit" className="w-full h-11 text-base font-medium" disabled={isLoading}>
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Verify & sign in"
                  )}
                </Button>

                <div className="text-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handlePhoneSubmit}
                    disabled={isLoading}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Resend code
                  </Button>
                </div>
              </form>
            )}

            <div className="pt-4 flex items-center justify-between text-sm border-t border-border/50">
              <Button variant="ghost" size="sm" onClick={handleBack} className="text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-4 h-4 mr-1" />
                {mode === "otp" ? "Change number" : "Back"}
              </Button>
              <Link to="/signin" className="text-primary hover:text-primary/90 transition-colors">
                Sign in with email
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
