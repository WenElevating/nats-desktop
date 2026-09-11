import { z } from "zod";

export const contextFormSchema = z.object({
  name: z.string().min(1, "connections.nameInvalid")
    .refine((s) => !/[/\\]/.test(s), "connections.nameInvalid"),
  url: z.string().url("connections.urlInvalid")
    .refine((s) => /^nats:\/\//.test(s) || /^tls:\/\//.test(s), "connections.urlInvalid"),
  description: z.string().optional(),
  authType: z.enum(["none", "userpass", "token", "creds", "nkey"]),
  user: z.string().optional(), password: z.string().optional(),
  token: z.string().optional(), creds: z.string().optional(), nkey: z.string().optional(),
  cert: z.string().optional(), key: z.string().optional(), ca: z.string().optional(),
  jsDomain: z.string().optional(), inboxPrefix: z.string().optional(),
  socksProxy: z.string().optional(), colorScheme: z.string().optional(),
  tlsFirst: z.boolean().optional(),
});
export type ContextFormValues = z.infer<typeof contextFormSchema>;
