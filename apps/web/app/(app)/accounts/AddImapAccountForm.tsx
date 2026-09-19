"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useAction } from "next-safe-action/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toastError, toastSuccess } from "@/components/Toast";
import { linkImapAccountAction } from "@/utils/actions/imap";
import type { ImapCredentialInput } from "@/utils/actions/imap.validation";
import { getActionErrorMessage } from "@/utils/error";

export function AddImapAccountForm() {
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, reset } = useForm<ImapCredentialInput>({
    defaultValues: {
      imapHost: "127.0.0.1",
      imapPort: 1143,
      imapSecurity: "starttls",
      smtpHost: "127.0.0.1",
      smtpPort: 1025,
      smtpSecurity: "starttls",
    },
  });
  const { execute, isExecuting } = useAction(linkImapAccountAction, {
    onSuccess: () => {
      reset();
      setOpen(false);
      toastSuccess({ description: "Mail account connected." });
      window.location.assign("/accounts");
    },
    onError: (error) =>
      toastError({
        title: "Could not connect account",
        description: getActionErrorMessage(error.error),
      }),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (isExecuting) return;
        setOpen(value);
        if (!value) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full">
          Add Proton / IMAP account
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect Proton Mail Bridge</DialogTitle>
          <DialogDescription>
            Keep Bridge running on the same computer as this app. Use its
            generated password, not your Proton password. Both connections are
            tested before saving.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit((data) => execute(data))}
          className="flex flex-col gap-3"
        >
          <label htmlFor="imap-email">Email address</label>
          <Input id="imap-email" type="email" required {...register("email")} />
          <label htmlFor="imap-name">Display name</label>
          <Input id="imap-name" {...register("name")} />
          <label htmlFor="imap-username">
            Bridge username (same email address)
          </label>
          <Input
            id="imap-username"
            autoComplete="off"
            required
            {...register("username")}
          />
          <label htmlFor="imap-password">Bridge password</label>
          <Input
            id="imap-password"
            type="password"
            autoComplete="new-password"
            required
            {...register("password")}
          />
          {(["imap", "smtp"] as const).map((protocol) => (
            <fieldset
              key={protocol}
              className="grid grid-cols-2 gap-2 border-t pt-3"
            >
              <legend>{protocol.toUpperCase()}</legend>
              <label htmlFor={`${protocol}-host`}>Host</label>
              <Input
                id={`${protocol}-host`}
                required
                {...register(`${protocol}Host`)}
              />
              <label htmlFor={`${protocol}-port`}>Port</label>
              <Input
                id={`${protocol}-port`}
                type="number"
                min={1}
                max={65_535}
                required
                {...register(`${protocol}Port`, { valueAsNumber: true })}
              />
              <label htmlFor={`${protocol}-security`}>Encryption</label>
              <select
                id={`${protocol}-security`}
                className="rounded border bg-background p-2"
                {...register(`${protocol}Security`)}
              >
                <option value="starttls">STARTTLS</option>
                <option value="tls">TLS</option>
              </select>
            </fieldset>
          ))}
          <p className="text-sm text-muted-foreground">
            Experimental: refresh to see mailbox changes. Background automation
            and offline Proton mail are not available yet.
          </p>
          <Button type="submit" disabled={isExecuting} loading={isExecuting}>
            Test and connect
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
