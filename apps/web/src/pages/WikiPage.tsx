import { useState, useEffect, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
    DocumentTextIcon,
    ChevronRightIcon,
    HomeIcon,
    MagnifyingGlassIcon,
    BookOpenIcon,
} from "@heroicons/react/24/outline";
import { client } from "../lib/rpc";
import MDXRenderer from "../components/wiki/MDXRenderer";
import WikiRightSidebar from "../components/wiki/WikiRightSidebar";

/**
 * Wiki structure representing the documentation hierarchy.
 */
interface WikiSection {
    name: string;
    path: string;
    description?: string;
    items?: WikiItem[];
}

interface WikiItem {
    name: string;
    file: string;
    description?: string;
}

/**
 * Wiki area grouping sections by audience.
 */
interface WikiArea {
    name: string;
    range: string;
    description: string;
    sections: WikiSection[];
}

/**
 * Wiki documentation structure using Johnny-decimal numbering.
 *
 * 10-19: General (all audiences)
 * 20-29: Users (consumers, subscribers)
 * 30-39: Creators (content creators, publishers)
 */
const wikiAreas: WikiArea[] = [
    {
        name: "General",
        range: "10-19",
        description: "Platform overview, core concepts, and information for everyone",
        sections: [
            {
                name: "Getting Started",
                path: "10-Getting-Started",
                description: "Introduction to Anthers and how it works",
                items: [
                    { name: "Overview", file: "README.md" },
                    { name: "What is Anthers?", file: "01-WhatIsAnthers.md" },
                    { name: "How Anthers Works", file: "02-HowAnthersWorks.md" },
                    { name: "Glossary", file: "03-Glossary.md" },
                ],
            },
            {
                name: "The Anthers Model",
                path: "11-The-Anthers-Model",
                description: "Transparent pricing, the CRF, and how money flows",
                items: [
                    { name: "Overview", file: "README.md" },
                    { name: "Transparent Pricing", file: "01-TransparentPricing.md" },
                    { name: "Community Resilience Fund", file: "02-CommunityResilienceFund.md" },
                    { name: "Creator Pool", file: "03-CreatorPool.md" },
                ],
            },
            {
                name: "Community & Federation",
                path: "12-Community-And-Federation",
                description: "AT Protocol, federation, and community guidelines",
                items: [
                    { name: "Overview", file: "README.md" },
                    { name: "Federation & AT Protocol", file: "01-FederationAndATProtocol.md" },
                    { name: "Community Guidelines", file: "02-CommunityGuidelines.md" },
                ],
            },
        ],
    },
    {
        name: "Users",
        range: "20-29",
        description: "Guides for subscribers, players, and content consumers",
        sections: [
            {
                name: "Account & Subscription",
                path: "20-Account-And-Subscription",
                description: "Creating your account and managing your subscription",
                items: [
                    { name: "Overview", file: "README.md" },
                    { name: "Creating an Account", file: "01-CreatingAnAccount.md" },
                    { name: "Subscription Tiers", file: "02-SubscriptionTiers.md" },
                    { name: "Managing Your Subscription", file: "03-ManagingYourSubscription.md" },
                ],
            },
            {
                name: "Discovering Content",
                path: "21-Discovering-Content",
                description: "Exploring projects, following creators, and your feed",
                items: [
                    { name: "Overview", file: "README.md" },
                    { name: "Exploring & Browsing", file: "01-ExploringAndBrowsing.md" },
                    { name: "Following Creators", file: "02-FollowingCreators.md" },
                    { name: "Your Feed & Library", file: "03-YourFeedAndLibrary.md" },
                ],
            },
            {
                name: "Playing & Purchasing",
                path: "22-Playing-And-Purchasing",
                description: "Downloading games, buying content, and using your library",
                items: [
                    { name: "Overview", file: "README.md" },
                    { name: "Purchasing Content", file: "01-PurchasingContent.md" },
                    { name: "Downloads & Game Jams", file: "02-DownloadsAndGameJams.md" },
                    { name: "Ratings & Comments", file: "03-RatingsAndComments.md" },
                ],
            },
        ],
    },
    {
        name: "Creators",
        range: "30-39",
        description: "Guides for publishing, monetizing, and growing on Anthers",
        sections: [
            {
                name: "Creator Setup",
                path: "30-Creator-Setup",
                description: "Setting up your creator profile and getting started",
                items: [
                    { name: "Overview", file: "README.md" },
                    { name: "Creator Profiles", file: "01-CreatorProfiles.md" },
                    { name: "Stripe Connect Setup", file: "02-StripeConnectSetup.md" },
                    { name: "Creator Hubs", file: "03-CreatorHubs.md" },
                ],
            },
            {
                name: "Publishing Content",
                path: "31-Publishing-Content",
                description: "Creating projects, posts, and media content",
                items: [
                    { name: "Overview", file: "README.md" },
                    { name: "Projects & Games", file: "01-ProjectsAndGames.md" },
                    { name: "Posts & Rich Text", file: "02-PostsAndRichText.md" },
                    { name: "Video & Audio", file: "03-VideoAndAudio.md" },
                    { name: "Game Jams", file: "04-GameJams.md" },
                ],
            },
            {
                name: "Monetization & Analytics",
                path: "32-Monetization-And-Analytics",
                description: "Pricing, earnings, analytics, and the Boost Pool",
                items: [
                    { name: "Overview", file: "README.md" },
                    { name: "Pricing Your Content", file: "01-PricingYourContent.md" },
                    { name: "Earnings & Payouts", file: "02-EarningsAndPayouts.md" },
                    { name: "Boost Pool & Premium Content", file: "03-BoostPoolAndPremiumContent.md" },
                    { name: "Analytics Dashboard", file: "04-AnalyticsDashboard.md" },
                ],
            },
        ],
    },
];

/**
 * Flat wiki structure for navigation and search.
 */
const wikiStructure: WikiSection[] = wikiAreas.flatMap((area) => area.sections);

/**
 * GitHub repository base URL for edit links.
 */
const GITHUB_REPO_URL = "https://github.com/parkerhdavis/Anthers";

/**
 * Wiki page component that displays documentation from the repo /wiki directory.
 * Features search, syntax highlighting, table of contents, prev/next navigation.
 */
export default function WikiPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const [content, setContent] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentSection, setCurrentSection] = useState<string | null>(null);
    const [currentFile, setCurrentFile] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [zoomLevel, setZoomLevel] = useState(1.0);

    // Parse the current path to determine section and file
    useEffect(() => {
        const pathParts = location.pathname.replace("/wiki", "").split("/").filter(Boolean);
        if (pathParts.length >= 2) {
            setCurrentSection(pathParts[0]);
            setCurrentFile(pathParts[1]);
        } else if (pathParts.length === 1) {
            setCurrentSection(pathParts[0]);
            setCurrentFile(null);
        } else {
            setCurrentSection(null);
            setCurrentFile(null);
        }
    }, [location]);

    // Fetch wiki content when section/file changes
    useEffect(() => {
        if (!currentSection || !currentFile) {
            setContent("");
            return;
        }

        const fetchWikiContent = async () => {
            setLoading(true);
            setError(null);
            try {
                // Wiki endpoint isn't part of the typed RPC routes, use raw fetch
                const baseUrl =
                    typeof location !== "undefined" &&
                    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
                        ? "http://localhost:8000"
                        : "";
                const res = await fetch(`${baseUrl}/api/wiki/${currentSection}/${currentFile}`);
                if (!res.ok) throw new Error(`Failed to load wiki page (${res.status})`);
                const data = await res.json();
                setContent(data.content);
            } catch (err) {
                setError(err instanceof Error ? err.message : "Unknown error");
                setContent("");
            } finally {
                setLoading(false);
            }
        };

        fetchWikiContent();
    }, [currentSection, currentFile]);

    // Get previous and next pages for navigation
    const { previousPage, nextPage } = useMemo(() => {
        if (!currentSection || !currentFile) {
            return { previousPage: null, nextPage: null };
        }

        // Flatten all pages into a single array
        const allPages: Array<{ section: string; file: string; name: string }> = [];
        wikiStructure.forEach((section) => {
            section.items?.forEach((item) => {
                allPages.push({
                    section: section.path,
                    file: item.file,
                    name: `${section.name} - ${item.name}`,
                });
            });
        });

        // Find current page index
        const currentIndex = allPages.findIndex(
            (page) => page.section === currentSection && page.file === currentFile
        );

        return {
            previousPage: currentIndex > 0 ? allPages[currentIndex - 1] : null,
            nextPage: currentIndex < allPages.length - 1 ? allPages[currentIndex + 1] : null,
        };
    }, [currentSection, currentFile]);

    // Filter sections based on search query (fuzzy search with AND logic)
    const filteredAreas = useMemo(() => {
        if (!searchQuery) return wikiAreas;

        const terms = searchQuery.toLowerCase().split(/[\s*]+/).filter(Boolean);
        return wikiAreas
            .map((area) => ({
                ...area,
                sections: area.sections
                    .map((section) => ({
                        ...section,
                        items: section.items?.filter((item) => {
                            const searchableText = [
                                item.name.toLowerCase(),
                                item.description?.toLowerCase() || "",
                                section.name.toLowerCase(),
                                area.name.toLowerCase(),
                            ].join(" ");
                            return terms.every((term) => searchableText.includes(term));
                        }),
                    }))
                    .filter((section) => section.items && section.items.length > 0),
            }))
            .filter((area) => area.sections.length > 0);
    }, [searchQuery]);

    const handleNavigate = (section: string, file: string) => {
        navigate(`/wiki/${section}/${file}`);
    };

    const handleSectionClick = (section: WikiSection) => {
        if (section.items && section.items.length > 0) {
            const firstItem =
                section.items.find((item) => item.file === "README.md") || section.items[0];
            handleNavigate(section.path, firstItem.file);
        }
    };

    // Render the wiki home/index view
    if (!currentSection) {
        const totalPages = wikiAreas.reduce(
            (acc, area) => acc + area.sections.reduce((sacc, s) => sacc + (s.items?.length || 0), 0),
            0
        );

        return (
            <div className="container mx-auto px-6 py-8 max-w-7xl">
                <div className="mb-8">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-12 h-12 bg-primary/20 rounded-lg flex items-center justify-center">
                            <BookOpenIcon className="h-7 w-7 text-primary" />
                        </div>
                        <div>
                            <h1 className="text-4xl font-bold text-base-content">
                                Anthers Wiki
                            </h1>
                            <p className="text-lg text-base-content/70">
                                Guides and documentation for users and creators
                            </p>
                        </div>
                    </div>
                    <div className="stats stats-vertical lg:stats-horizontal shadow w-full bg-base-100 border border-base-300">
                        <div className="stat">
                            <div className="stat-title">Areas</div>
                            <div className="stat-value text-primary">{wikiAreas.length}</div>
                            <div className="stat-desc">General, Users, Creators</div>
                        </div>
                        <div className="stat">
                            <div className="stat-title">Sections</div>
                            <div className="stat-value text-secondary">{wikiStructure.length}</div>
                            <div className="stat-desc">Documentation sections</div>
                        </div>
                        <div className="stat">
                            <div className="stat-title">Pages</div>
                            <div className="stat-value text-accent">{totalPages}</div>
                            <div className="stat-desc">Total documentation pages</div>
                        </div>
                    </div>
                </div>

                {/* Search bar */}
                <div className="mb-8">
                    <div className="relative">
                        <MagnifyingGlassIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-base-content/50" />
                        <input
                            type="text"
                            placeholder="Search documentation..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="input input-bordered w-full pl-12"
                        />
                    </div>
                </div>

                {/* Quick Start */}
                <div className="mb-12">
                    <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                        <span className="badge badge-primary badge-lg">Quick Start</span>
                    </h2>
                    <div className="card bg-base-100 border border-base-300 p-6">
                        <ol className="space-y-3">
                            <li className="flex items-start gap-3">
                                <span className="badge badge-primary badge-lg">1</span>
                                <div>
                                    <button
                                        onClick={() =>
                                            handleNavigate("10-Getting-Started", "01-WhatIsAnthers.md")
                                        }
                                        className="link link-primary font-semibold"
                                    >
                                        What is Anthers?
                                    </button>
                                    <p className="text-sm text-base-content/60">
                                        Learn about the platform and its mission
                                    </p>
                                </div>
                            </li>
                            <li className="flex items-start gap-3">
                                <span className="badge badge-primary badge-lg">2</span>
                                <div>
                                    <button
                                        onClick={() =>
                                            handleNavigate("11-The-Anthers-Model", "README.md")
                                        }
                                        className="link link-primary font-semibold"
                                    >
                                        The Anthers Model
                                    </button>
                                    <p className="text-sm text-base-content/60">
                                        Understand transparent pricing and the CRF
                                    </p>
                                </div>
                            </li>
                            <li className="flex items-start gap-3">
                                <span className="badge badge-primary badge-lg">3</span>
                                <div>
                                    <button
                                        onClick={() =>
                                            handleNavigate("20-Account-And-Subscription", "README.md")
                                        }
                                        className="link link-primary font-semibold"
                                    >
                                        Get Started as a User
                                    </button>
                                    <p className="text-sm text-base-content/60">
                                        Create an account and explore content
                                    </p>
                                </div>
                            </li>
                            <li className="flex items-start gap-3">
                                <span className="badge badge-primary badge-lg">4</span>
                                <div>
                                    <button
                                        onClick={() =>
                                            handleNavigate("30-Creator-Setup", "README.md")
                                        }
                                        className="link link-primary font-semibold"
                                    >
                                        Get Started as a Creator
                                    </button>
                                    <p className="text-sm text-base-content/60">
                                        Set up your creator profile and start publishing
                                    </p>
                                </div>
                            </li>
                        </ol>
                    </div>
                </div>

                {/* Areas and sections */}
                {filteredAreas.map((area) => (
                    <div key={area.range} className="mb-10">
                        <h2 className="text-2xl font-bold mb-2 text-secondary">
                            {searchQuery
                                ? `${area.name} (${area.sections.reduce((acc, s) => acc + (s.items?.length || 0), 0)} results)`
                                : area.name}
                        </h2>
                        <p className="text-sm text-base-content/60 mb-6">{area.description}</p>

                        <div className="space-y-6">
                            {area.sections.map((section) => (
                                <div key={section.path} className="border-l-2 border-primary/30 pl-4">
                                    <button
                                        onClick={() => handleSectionClick(section)}
                                        className="flex items-center gap-3 group mb-2"
                                    >
                                        <span className="text-primary font-bold text-lg w-8">
                                            {section.path.split("-")[0]}.
                                        </span>
                                        <h3 className="font-semibold text-lg text-base-content group-hover:text-primary transition-colors">
                                            {section.name}
                                        </h3>
                                        <span className="badge badge-sm badge-ghost">
                                            {section.items?.length || 0} pages
                                        </span>
                                    </button>
                                    {section.description && (
                                        <p className="text-sm text-base-content/60 ml-11 mb-2">
                                            {section.description}
                                        </p>
                                    )}
                                    {section.items && section.items.length > 0 && (
                                        <ul className="ml-11 space-y-1">
                                            {section.items.map((item) => (
                                                <li key={item.file}>
                                                    <button
                                                        onClick={() => handleNavigate(section.path, item.file)}
                                                        className="flex items-center gap-2 text-sm text-base-content/70 hover:text-primary transition-colors py-0.5"
                                                    >
                                                        <DocumentTextIcon className="h-4 w-4 flex-shrink-0" />
                                                        <span>{item.name}</span>
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                ))}

                {searchQuery && filteredAreas.length === 0 && (
                    <div className="alert">
                        <span>No results found for "{searchQuery}"</span>
                    </div>
                )}
            </div>
        );
    }

    // Find the current section
    const section = wikiStructure.find((s) => s.path === currentSection);

    // Render section view with file list
    if (!currentFile && section) {
        return (
            <div className="container mx-auto px-6 py-8 max-w-7xl">
                <div className="breadcrumbs text-sm mb-6">
                    <ul>
                        <li>
                            <button onClick={() => navigate("/wiki")} className="link">
                                <HomeIcon className="h-4 w-4" />
                                Wiki
                            </button>
                        </li>
                        <li>{section.name}</li>
                    </ul>
                </div>

                <h1 className="text-4xl font-bold text-base-content mb-4">{section.name}</h1>
                {section.description && (
                    <p className="text-lg text-base-content/70 mb-8">{section.description}</p>
                )}

                <div className="space-y-2">
                    {section.items?.map((item) => (
                        <button
                            key={item.file}
                            onClick={() => handleNavigate(section.path, item.file)}
                            className="card bg-base-100 border border-base-300 hover:border-primary transition-all text-left p-4 w-full flex items-center gap-3"
                        >
                            <DocumentTextIcon className="h-5 w-5 text-primary" />
                            <div className="flex-1">
                                <h3 className="font-medium text-base-content">{item.name}</h3>
                                {item.description && (
                                    <p className="text-sm text-base-content/60">
                                        {item.description}
                                    </p>
                                )}
                            </div>
                            <ChevronRightIcon className="h-5 w-5 text-base-content/40" />
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    // Render document view with markdown content
    return (
        <div className="flex h-full">
            {/* Main content area */}
            <div
                className="flex-1 px-8 pt-8 min-w-0"
                style={{ fontSize: `${zoomLevel}rem` }}
            >
                <div className="max-w-[1100px] mx-auto">
                    <div className="breadcrumbs text-sm mb-6">
                        <ul>
                            <li>
                                <button onClick={() => navigate("/wiki")} className="link">
                                    <HomeIcon className="h-4 w-4" />
                                    Wiki
                                </button>
                            </li>
                            {section && (
                                <li>
                                    <button
                                        onClick={() => navigate(`/wiki/${section.path}`)}
                                        className="link"
                                    >
                                        {section.name}
                                    </button>
                                </li>
                            )}
                            {currentFile && <li>{currentFile}</li>}
                        </ul>
                    </div>

                    {loading && (
                        <div className="flex items-center justify-center py-12">
                            <span className="loading loading-spinner loading-lg"></span>
                        </div>
                    )}

                    {error && (
                        <div className="alert alert-error">
                            <span>{error}</span>
                        </div>
                    )}

                    {content && !loading && (
                        <MDXRenderer
                            content={content}
                            onNavigate={handleNavigate}
                            className="prose prose-lg max-w-none
                                prose-headings:scroll-mt-20
                                prose-h1:text-primary prose-h1:font-bold prose-h1:mb-8 prose-h1:pb-4 prose-h1:border-b prose-h1:border-base-content/10
                                prose-h2:text-secondary prose-h2:font-semibold
                                prose-h3:text-accent prose-h3:font-semibold
                                prose-img:rounded-lg prose-img:border prose-img:border-base-content/10
                            "
                        />
                    )}
                </div>
            </div>

            {/* Right sidebar - fixed to right edge */}
            {content && (
                <WikiRightSidebar
                    content={content}
                    previousPage={previousPage}
                    nextPage={nextPage}
                    onNavigate={handleNavigate}
                    zoomLevel={zoomLevel}
                    onZoomChange={setZoomLevel}
                />
            )}
        </div>
    );
}
