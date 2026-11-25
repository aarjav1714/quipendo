import { openExporter } from './openExporter';
import { ext } from './ui/webext';

/** Opens (or focuses) the exporter page; if the user was on a Quip page, offers it as the export scope. */
ext.action.onClicked.addListener((tab) => void openExporter(ext, tab));
