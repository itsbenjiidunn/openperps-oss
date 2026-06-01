import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "@/components/openperps/Landing";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "OpenPerps · Perpetual futures for any Solana token" },
      {
        name: "description",
        content:
          "List a perp market for any Solana token and trade it long or short. No permission. No admin keys. Live on devnet.",
      },
    ],
  }),
  component: Landing,
});
