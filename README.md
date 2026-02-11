Phish Demo



Phish Demo is a web‑based demonstration tool for analyzing Korean phishing and scam messages. The app allows you to paste or select an example conversation and then uses a combination of rule‑based scoring, prefilter heuristics, similarity search and optional sentence embedding to estimate the risk and guide the user through the analysis. It visualizes results in a simulated phone UI with a risk gauge, evidence cards, timeline, and actionable recommendations.



Features



Interactive UI – Built with React and TypeScript, the application provides a responsive interface with a phone‑like chat display. The UI includes a risk gauge, top signals, timeline of stage transitions and evidence panels.



Phishing/scam detection engine – The engine normalizes and splits conversations into sender/receiver turns, applies a prefilter to catch obvious signals, and computes a score and risk level. It extracts URLs, OTP requests, remote‑control or installation prompts, transfer requests and more to decide stages and risk. The engine supports optional similarity matching and semantic embedding to suggest similar known cases.



Example datasets – Under public/datasets/ko\_scam and datasets/ko\_scam you will find multiple JSONL files containing curated examples of scams and normal conversations. These include categories such as v3\_200, url\_mut200, gen500 and mlm1453. The ExamplePicker component loads these datasets dynamically to populate the examples drop‑down.



CLI tools – The tools directory contains scripts to run the engine against datasets, generate scenario stubs, build semantic/similarity indexes and perform various analytics. Example npm scripts such as test:dataset, test:dataset:quick, and deploy can be found in package.json.



Installation



Clone this repository.



Install dependencies:



npm install





Run the development server:



npm run dev





This uses Vite and will start a local dev server (default at http://localhost:5173).



For a production build:



npm run build

npm run preview





To test the engine on example datasets via the CLI:



npm run test:dataset





Use the :quick variants to limit to a small number of cases or specify a custom path with the --path option.



Project Structure



src/engine – Core analysis functions. index.ts ties together text normalization, splitting, scoring, prefilter, similarity search and semantic embedding.



src/pages/AnalyzePage.tsx – The main React component providing the user interface. It hooks into the engine, manages state and renders the phone UI, gauge, timeline and control panels.



src/data/examples.ts – Contains a small set of hard‑coded examples used when no remote dataset is loaded.



public/datasets – Publicly served datasets used by the ExamplePicker to populate example conversations.



tools – Node/TS scripts for dataset processing, generation and testing.



package.json – Lists dependencies (React, Vite, @xenova/transformers, etc.) and defines scripts.



Technologies



React and TypeScript – The frontend is written in TSX with Vite for bundling.



Vite – Provides a fast development server and build pipeline.



@xenova/transformers – Optional dependency for semantic embeddings and similarity search.



Node / tsx – CLI tools are run with tsx, enabling TypeScript execution without compilation.



Cloudflare Workers – A deploy script using wrangler is included for deploying to Cloudflare Workers.



Usage



Open the web application, paste a conversation thread or select an example from the drop‑down, and click “Analyze”. The tool will display:



The estimated risk level (low, medium or high) and score.



Evidence items that contributed most to the risk score.



A timeline showing the progression through stages like info, verify, install and payment.



Recommended actions and similarity hints when relevant.



A simulated phone UI with colour‑coded message bubbles and alert bars.



This project is for demonstration and research purposes only. It is not intended to replace professional security solutions.

