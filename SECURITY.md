# Security Policy

Anthers handles people's money, people's creative work, and people's personal data. Security reports are welcome from anyone, at any time, whether or not the platform is accepting other kinds of contribution.

## Reporting a vulnerability

Email **[contact@anthers.org](mailto:contact@anthers.org)** with `SECURITY` in the subject line. Please include:

- What you found, and where — a URL, an endpoint, a file and line, whatever locates it.
- How to reproduce it, in enough detail that we can see it happen.
- What you think an attacker could do with it.

If you would rather report privately through GitHub, [open a draft security advisory](https://github.com/anthers-inc/Anthers/security/advisories/new) instead — it stays private between you and us until we publish it.

**Please do not open a public issue for a vulnerability.** That is the one report we would rather receive slowly than publicly.

### What to expect

Anthers is run by one person right now, so we will not pretend to a pager rotation we do not have. What we commit to:

- **An acknowledgement within 3 business days**, from a human.
- **An assessment within 10 business days** — whether we agree it is a vulnerability, how severe we think it is, and what we intend to do.
- **Credit in the fix**, by whatever name you like, unless you would rather stay anonymous.
- **Telling you when it is fixed**, and telling you honestly if we decide not to fix it and why.

If you do not hear back within 3 business days, assume the mail went astray and send it again — that is a failure on our end, not a signal to escalate publicly.

## Safe harbour

We will not pursue or support legal action against anyone who makes a good-faith effort to follow this policy. Good faith means:

- Work only against **your own accounts and your own content**, or accounts you have explicit permission to test.
- **Do not access, modify, or retain other people's data.** If you stumble into someone else's data proving a point, stop, and tell us what you saw so we can assess the exposure.
- **Do not degrade the service** — no denial of service, no load testing, no spam or bulk automated requests against production.
- **Do not use social engineering, phishing, or physical access** against Anthers or anyone who works with it.
- Give us a reasonable chance to fix the issue before disclosing it publicly.

Work against a local checkout wherever you can. `make dev` gives you the whole platform on your own machine, which is a better test bed than production and carries none of the above risk.

## Scope

**In scope:** the code in this repository, and the deployed platform at `anthers.org` and its subdomains — the API, the web app, the creator Studio, and the desktop shell.

Things we care about especially, because of what they guard:

- **Access resolution** — anything that yields a Work someone should not be able to reach, or bytes from the private bucket without a signed URL.
- **Payments** — anything that moves money incorrectly, misattributes a payout, or lets someone charge, refund, or receive money they should not.
- **Session and account integrity** — session fixation or theft, CSRF, account takeover, and anything that lets one account act as another.
- **Data exposure** — personal data reaching anywhere it should not, including third parties. The platform is designed to make **no off-origin request at all**; if you find one, that is a finding on its own.

**Out of scope**, unless you can show real impact:

- **The pre-launch site gate (`SiteGate`).** It holds a soft launch closed; it is not a security boundary and was never built as one. Passing it is a client-side flag, so walking around it is expected rather than a finding. What sits behind it is the same content an unauthenticated visitor would see after launch — every decision about *private* content (a gated Work, a purchase, a draft, another account's data) is made server-side by the access resolver, and the gate is not part of it. A way past the gate is not a report; a way to reach something the resolver should have refused very much is.
- Missing hardening headers, TLS configuration nitpicks, and scanner output with no demonstrated exploit.
- Denial of service, volumetric attacks, and rate-limit findings that amount to "I sent a lot of requests."
- Vulnerabilities in third-party services (Stripe, Cloudflare, DigitalOcean) — report those to the vendor.
- Anything requiring physical access to a user's unlocked device, or a compromised browser or operating system.

## Supported versions

There is one deployment and it runs from `main`. Fixes land there; there are no maintained release branches to backport to. Anyone self-hosting a fork should track `main`.
