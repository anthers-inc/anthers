import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

interface FAQItem {
  question: string;
  answer: string | ReactNode;
  category: string;
}

const FAQ_ITEMS: FAQItem[] = [
  {
    category: "Feed & Discovery",
    question:
      "How does the feed work? Is there an algorithm like other social/media sites?",
    answer: (
      <div className="space-y-2">
        <p>
          The Anthers feed is not driven by a traditional engagement-maximizing
          algorithm. By default, you see content in three layers:
        </p>
        <ul className="list-disc list-inside space-y-1 text-base-content/70">
          <li>
            <strong>Primary:</strong> Content from creators you follow and
            support
          </li>
          <li>
            <strong>Network:</strong> Things your follows have liked, shared, or
            purchased
          </li>
          <li>
            <strong>Ambient:</strong> Content matching your stated interests
            (tags, jams) -- never paid promotion
          </li>
        </ul>
        <p>
          Everything in your feed is attributed so you know exactly why it's
          there. You can also subscribe to Custom Feeds and Custom Algorithms
          created by other users, giving you full control over what you see.
          Anthers never uses paid promotion or engagement optimization to
          influence your feed.
        </p>
      </div>
    ),
  },
  {
    category: "Feed & Discovery",
    question: "What are Custom Feeds?",
    answer:
      "Custom Feeds are alternative feed views created by other users or creators. They can be algorithmic (dynamically adapting to your data) or curated (showing the same content to everyone who subscribes). You can subscribe to any published feed and switch between feeds from the selector on your Home page.",
  },
  {
    category: "Feed & Discovery",
    question: "Does Anthers sell promoted or sponsored content placement?",
    answer:
      "No. Anthers does not sell promoted content placement in feeds, search results, or anywhere else. What you see is always based on your relationships, your interests, and your choices -- never on who paid the most.",
  },
  {
    category: "Subscriptions & Payments",
    question: "How does the subscription model work?",
    answer: (
      <div className="space-y-2">
        <p>
          Anthers uses a subscription pool model. When you subscribe at any tier
          (Root $3, Sprout $7, Petal $15, or Bloom $30), your payment is split:
        </p>
        <ul className="list-disc list-inside space-y-1 text-base-content/70">
          <li>
            <strong>92%</strong> goes to creators (via the Creator Pool and your
            Boost allocations)
          </li>
          <li>
            <strong>8%</strong> funds the Anthers Foundation (charitable programs
            and operations)
          </li>
        </ul>
        <p>
          The Creator Pool is distributed based on your attention time -- the
          creators you actually engage with get paid. Your Boost Pool lets you
          additionally direct funds to specific creators and unlock gated
          content.
        </p>
      </div>
    ),
  },
  {
    category: "Subscriptions & Payments",
    question: "What is the Anthers Foundation?",
    answer:
      "The Foundation receives 8% of all subscription revenue and allocates it between charitable programs (infrastructure equity, education, creation grants, emergency assistance) and organizational operations, with at least 50% going to programs.",
  },
  {
    category: "Subscriptions & Payments",
    question: "How do direct purchases work?",
    answer:
      "For direct purchases (buying a game, download, etc.), fees are added on top of the creator's price rather than deducted from it. The creator receives 100% of their listed price. Processing fees and a small Foundation Fee are paid by the buyer as a transparent pass-through.",
  },
  {
    category: "Creators",
    question: "How much do creators keep?",
    answer:
      "From subscriptions, creators receive 92% of revenue through the pool system. From direct purchases, creators receive 100% of their listed price -- fees are added on top and paid by the buyer. Anthers never takes a cut from creator earnings.",
  },
  {
    category: "Creators",
    question: "What kinds of content can I publish?",
    answer:
      "Anthers supports games (browser-playable and downloadable), video, audio (music, podcasts), and written content (articles, stories, tutorials). All media types are first-class citizens with dedicated player/reader experiences.",
  },
  {
    category: "Jams & Contests",
    question: "What are Jams?",
    answer:
      "Jams are creative contests where sponsors put out calls for content and creators compete. They support all media types -- not just games. Jams can be sponsored by companies, educators, organizations, the Anthers Foundation, or individual creators. Some jams are size-gated to ensure emerging creators get fair opportunities.",
  },
  {
    category: "Platform & Identity",
    question: "What is AT Protocol / Bluesky integration?",
    answer:
      "Anthers is built on the AT Protocol, the same decentralized protocol that powers Bluesky. This means your identity, content, and relationships are portable -- you're not locked into Anthers. You can link your Bluesky account to sign in and eventually your content will be federated across the AT Protocol network.",
  },
  {
    category: "Platform & Identity",
    question: "Is Anthers open source?",
    answer:
      "Anthers is built with federation in mind. The platform uses open protocols (AT Protocol) so creators can eventually host their own nodes. The goal is that no single entity -- including Anthers itself -- can become a gatekeeper.",
  },
];

const CATEGORIES = [...new Set(FAQ_ITEMS.map((item) => item.category))];

function FAQAccordion({ item }: { item: FAQItem }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="collapse collapse-arrow bg-base-200">
      <input
        type="checkbox"
        checked={open}
        onChange={() => setOpen(!open)}
      />
      <div className="collapse-title font-medium text-sm">
        {item.question}
      </div>
      <div className="collapse-content text-sm text-base-content/70">
        {typeof item.answer === "string" ? <p>{item.answer}</p> : item.answer}
      </div>
    </div>
  );
}

export default function FAQPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <h1 className="text-3xl font-bold mb-2">Frequently Asked Questions</h1>
      <p className="text-base-content/60 mb-8">
        Everything you need to know about how Anthers works.
      </p>

      {CATEGORIES.map((category) => (
        <section key={category} className="mb-8">
          <h2 className="text-lg font-semibold mb-3 text-base-content/80">
            {category}
          </h2>
          <div className="flex flex-col gap-2">
            {FAQ_ITEMS.filter((item) => item.category === category).map(
              (item) => (
                <FAQAccordion key={item.question} item={item} />
              ),
            )}
          </div>
        </section>
      ))}

      <div className="text-center py-8 border-t border-base-300/50 mt-8">
        <p className="text-sm text-base-content/50 mb-3">
          Still have questions?
        </p>
        <div className="flex gap-3 justify-center">
          <Link to="/about" className="btn btn-ghost btn-sm">
            About Anthers
          </Link>
          <Link to="/wiki" className="btn btn-ghost btn-sm">
            Wiki
          </Link>
        </div>
      </div>
    </div>
  );
}
