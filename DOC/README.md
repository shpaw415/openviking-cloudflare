# Tutoriels OpenViking sur Cloudflare Workers

Ces guides couvrent ce qui change avec ce portage. Il s’agit d’un **Worker natif**, pas d’un projet Cloudflare Pages ni d’un proxy vers le serveur OpenViking Python.

1. [Construire, vérifier et déployer le Worker](DEPLOIEMENT.md) : Studio stagé, actifs de livraison, domaine HTTPS et secret d’amorçage.
2. [Gérer les comptes et les clés à distance](ADMINISTRATION.md) : créer un compte, inscrire un utilisateur, renouveler sa clé et la remplacer sans redéploiement.
3. [Configurer et tester les fonctions propres au portage](CONFIGURATION.md) : modes locaux, Workers AI, options et limites.
4. [Envoyer un fichier de configuration des modèles](FOURNISSEURS.md) : OpenAI, Llama via Workers AI ou API compatible, validation et application sans redéployer.

Pour installer et utiliser le client `ov`, les SDK et les fonctions communes, consulter la [documentation officielle OpenViking](https://github.com/volcengine/OpenViking/blob/000f0765d7ec183886fbabbc22e69bc289cc429d/docs/en/index.md) et le [guide CLI au même commit](https://github.com/volcengine/OpenViking/blob/000f0765d7ec183886fbabbc22e69bc289cc429d/docs/en/getting-started/05-cli-setup.md). Le [rapport de portage](../docs/PORTAGE.md) détaille les écarts : ces tutoriels ne présument ni parité intégrale ni validation sur Cloudflare distant.
